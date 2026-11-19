import type { EngineInterface, ImageSource, Register } from 'claude-code'

import { decodeBmp } from './bmp'
import { fitCells, renderCells } from './raster'
import type { Pixels } from './raster'
import { drawsPictures, historyIndex, imagesOf, rowKey, sentImages } from './sources'
import type { Found, Source } from './sources'

type Renderer = 'pixels' | 'symbols' | 'blocks'
type Settings = { renderer: Renderer | 'auto'; maxColumns: number; maxRows: number }

/** A picture decoded to disk: a full-size PNG and a small pixel copy for cells. */
type Decoded = {
  png: string
  pixels: string
  format: 'rgba' | 'bmp'
  /** The pixel copy's size. */
  width: number
  height: number
  /** The picture's own size. */
  original: { width: number; height: number }
}
type Picture = Decoded & { n: number }

// The pixel copy kept for cells: 480 across covers 120 columns of symbols.
const CELL_SOURCE = '480'
const DECODE_TIMEOUT_MS = 20_000
const MAX_DECODES = 3
// The narrowest a picture is drawn before the column limits apply.
const MIN_COLUMNS = 8
// The most bytes an Image takes.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

// Every picture this load has decoded, numbered in the order it met them.
const catalog: Picture[] = []
const byContent = new Map<string, Promise<Picture | undefined>>()
const byKey = new Map<string, Picture[]>()
const pixelCache = new Map<string, Pixels | null>()
const cellCache = new Map<string, string>()
const sentCache = new Map<string, ImageSource>()
type History = { index: Map<string, Source[]>; numbers: Map<string, number>; count: number }
let history: Promise<History> | undefined
// Images met after the loaded conversation's own, numbered after them.
let added = 0
let cacheDir: string | undefined
let hasMagick: boolean | undefined
let decoding = 0
const queued: (() => void)[] = []

// What a picture is, whichever read of the conversation it came from.
const sourceKey = (source: Source) => ('data' in source ? source.data : `file:${source.path}`)

const digest = async (text: string) => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(hash).slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Runs `work` once fewer than MAX_DECODES decodes are running. */
const limited = async <T,>(work: () => Promise<T>): Promise<T> => {
  while (decoding >= MAX_DECODES) await new Promise<void>(resolve => queued.push(resolve))
  decoding++
  try {
    return await work()
  } finally {
    decoding--
    queued.shift()?.()
  }
}

/** A command's stdout when it ran and exited 0; undefined otherwise. */
async function run($: EngineInterface, argv: string[], stdin?: string) {
  const init = stdin === undefined ? { timeoutMs: DECODE_TIMEOUT_MS } : { stdin, timeoutMs: DECODE_TIMEOUT_MS }
  const ran = await $.process.run(argv, init).catch(() => undefined)
  return ran?.exitCode === 0 ? ran.stdout : undefined
}

async function dirFor($: EngineInterface) {
  if (cacheDir !== undefined) return cacheDir
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const dir = `${tmp}/claude-inline-images`
  await run($, ['mkdir', '-p', dir])
  cacheDir = dir
  return dir
}

/** What names a picture's content: its bytes, or a file's path, size and age. */
async function contentId($: EngineInterface, source: Source) {
  if ('data' in source) return digest(source.data)
  const stat = await $.fs.stat(source.path).catch(() => undefined)
  if (stat?.kind !== 'file') return undefined
  return digest(`${source.path}\n${stat.size}\n${stat.mtimeMs}`)
}

/** A decode an earlier load left on disk, when its files are still there. */
async function cached($: EngineInterface, base: string): Promise<Decoded | undefined> {
  const text = await $.fs.read(`${base}.json`).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  try {
    const decoded = JSON.parse(text) as Decoded
    return (await $.fs.exists(decoded.pixels)) && (await $.fs.exists(decoded.png)) ? decoded : undefined
  } catch {
    return undefined
  }
}

/** Decodes with ImageMagick: a PNG of the whole picture, and raw RGBA at most 480 across. */
async function withMagick($: EngineInterface, base: string, source: Source): Promise<Decoded | undefined> {
  if (hasMagick === false) return undefined
  // ImageMagick 7.1.2 refuses `inline:-` (a data URI on stdin) as a policy
  // error, so pasted bytes go through a file. GNU and macOS base64 both take -d.
  const input = 'data' in source ? `${base}.src` : source.path
  if ('data' in source && (await run($, ['sh', '-c', 'base64 -d >"$1"', 'sh', input], source.data)) === undefined) {
    return undefined
  }
  const argv = [
    'magick', input, '-delete', '1--1', '-auto-orient',
    '-print', '%w %h ', '-write', `png:${base}.png`,
    '-resize', `${CELL_SOURCE}x${CELL_SOURCE}>`, '-depth', '8', '-write', `rgba:${base}.rgba`,
    '-format', '%w %h', 'info:',
  ]
  const ran = await $.process.run(argv, { timeoutMs: DECODE_TIMEOUT_MS }).catch(() => undefined)
  if (ran === undefined) {
    hasMagick = false
    return undefined
  }
  hasMagick = true
  if (ran.exitCode !== 0) return undefined

  const [originalWidth = 0, originalHeight = 0, width = 0, height = 0] = ran.stdout.trim().split(/\s+/).map(Number)
  if (!(width > 0 && height > 0)) return undefined
  return {
    png: `${base}.png`,
    pixels: `${base}.rgba`,
    format: 'rgba',
    width,
    height,
    original: { width: originalWidth || width, height: originalHeight || height },
  }
}

/** Decodes with macOS's own sips: a PNG of the whole picture, and a BMP at most 480 across. */
async function withSips($: EngineInterface, base: string, source: Source): Promise<Decoded | undefined> {
  const input = 'data' in source ? `${base}.src` : source.path
  if ('data' in source && (await run($, ['/usr/bin/base64', '-D', '-o', input], source.data)) === undefined) {
    return undefined
  }
  const size = await run($, ['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', input])
  const png = await run($, ['/usr/bin/sips', '-s', 'format', 'png', input, '--out', `${base}.png`])
  const bmp = await run($, ['/usr/bin/sips', '-s', 'format', 'bmp', '-Z', CELL_SOURCE, input, '--out', `${base}.bmp`])
  if (size === undefined || png === undefined || bmp === undefined) return undefined

  const pixels = await readPixels($, `${base}.bmp`, 'bmp', 0, 0)
  if (pixels === undefined) return undefined
  const originalWidth = Number(/pixelWidth:\s*(\d+)/.exec(size)?.[1] ?? pixels.width)
  const originalHeight = Number(/pixelHeight:\s*(\d+)/.exec(size)?.[1] ?? pixels.height)
  return {
    png: `${base}.png`,
    pixels: `${base}.bmp`,
    format: 'bmp',
    width: pixels.width,
    height: pixels.height,
    original: { width: originalWidth, height: originalHeight },
  }
}

async function readPixels($: EngineInterface, path: string, format: 'rgba' | 'bmp', width: number, height: number) {
  if (!pixelCache.has(path)) {
    const read = await $.fs.read(path, { as: 'bytes' }).catch(() => undefined)
    const bytes = read === undefined ? undefined : Uint8Array.fromBase64((read as { base64: string }).base64)
    const pixels =
      bytes === undefined ? null
      : format === 'bmp' ? decodeBmp(bytes)
      : bytes.length === width * height * 4 ? { width, height, rgba: bytes }
      : null
    pixelCache.set(path, pixels)
  }
  return pixelCache.get(path) ?? undefined
}

async function produce($: EngineInterface, id: string, source: Source, n: number): Promise<Picture | undefined> {
  const base = `${await dirFor($)}/${id}`
  const reused = await cached($, base)
  const decoded = reused ?? (await withMagick($, base, source)) ?? (await withSips($, base, source))
  if (decoded === undefined) return undefined
  if (reused === undefined) await $.fs.write(`${base}.json`, JSON.stringify(decoded)).catch(() => undefined)

  const picture = { ...decoded, n }
  catalog.push(picture)
  return picture
}

/** Starts decoding a picture once per content, however many rows show it; `numberOf` names a new one. */
async function decode($: EngineInterface, source: Source, numberOf: () => number) {
  const id = await contentId($, source)
  if (id === undefined) return { job: Promise.resolve(undefined) }
  let job = byContent.get(id)
  if (job === undefined) {
    const n = numberOf()
    job = limited(() => produce($, id, source, n)).catch(() => undefined)
    byContent.set(id, job)
  }
  return { job }
}

/** Every image of the conversation as loaded, numbered in the order it holds them. */
async function loadHistory($: EngineInterface): Promise<History> {
  const messages = await $.session.messages({ as: 'api' }).catch(() => [])
  const cwd = await $.session.root().catch(() => '')
  const index = historyIndex(messages, cwd)
  const numbers = new Map<string, number>()
  for (const sources of index.values()) {
    for (const source of sources) if (!numbers.has(sourceKey(source))) numbers.set(sourceKey(source), numbers.size + 1)
  }
  return { index, numbers, count: numbers.size }
}

async function historyFor($: EngineInterface) {
  history ??= loadHistory($)
  return history
}

/**
 * Decodes a row's pictures and files them under the key the row is drawn by:
 * one the loaded conversation holds keeps its number there, a new one is
 * numbered after them, in the order the row holds them.
 */
async function remember($: EngineInterface, key: string, sources: Source[], known?: History) {
  const { numbers, count } = known ?? (await historyFor($))
  const jobs: Promise<Picture | undefined>[] = []
  for (const source of sources) {
    const { job } = await decode($, source, () => numbers.get(sourceKey(source)) ?? count + ++added)
    jobs.push(job)
  }
  const decoded = await Promise.all(jobs)
  const filed = byKey.get(key) ?? []
  const fresh = decoded.filter((picture): picture is Picture => picture !== undefined && !filed.includes(picture))
  if (fresh.length > 0) byKey.set(key, [...filed, ...fresh])
}

/** The pictures drawn under these keys: seen live, or found in a loaded conversation. */
async function picturesFor($: EngineInterface, keys: string[], promptText?: string) {
  const pictures: Picture[] = []
  for (const key of keys) {
    if (!byKey.has(key)) {
      const loaded = await historyFor($)
      const sources = loaded.index.get(key) ?? (promptText === undefined ? undefined : loaded.index.get(`prompt:${promptText.trim()}`))
      if (sources !== undefined) await remember($, key, sources, loaded)
    }
    for (const picture of byKey.get(key) ?? []) if (!pictures.includes(picture)) pictures.push(picture)
  }
  return pictures
}

async function rendererFor($: EngineInterface, settings: Settings): Promise<Renderer> {
  if (settings.renderer !== 'auto') return settings.renderer
  const draws = drawsPictures({
    TERM: await $.env.get('TERM'),
    TERM_PROGRAM: await $.env.get('TERM_PROGRAM'),
    TMUX: await $.env.get('TMUX'),
    STY: await $.env.get('STY'),
    KITTY_WINDOW_ID: await $.env.get('KITTY_WINDOW_ID'),
    GHOSTTY_RESOURCES_DIR: await $.env.get('GHOSTTY_RESOURCES_DIR'),
    CLAUDE_CODE_FORCE_TERMINAL_IMAGES: await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES'),
    CLAUDE_CODE_SESSION_KIND: await $.env.get('CLAUDE_CODE_SESSION_KIND'),
  })
  return draws ? 'pixels' : 'symbols'
}

async function cellsFor($: EngineInterface, picture: Picture, columns: number, rows: number, renderer: Renderer) {
  const style = renderer === 'blocks' ? 'halves' : 'symbols'
  const key = `${picture.pixels}@${columns}x${rows}:${style}`
  if (!cellCache.has(key)) {
    const pixels = await readPixels($, picture.pixels, picture.format, picture.width, picture.height)
    if (pixels === undefined) return undefined
    cellCache.set(key, renderCells(pixels, columns, rows, style))
  }
  return cellCache.get(key)
}

/** Whether the terminal surely runs on this machine: not over ssh, not in tmux or screen. */
async function onThisMachine($: EngineInterface) {
  const elsewhere = [
    await $.env.get('TMUX'),
    await $.env.get('STY'),
    await $.env.get('SSH_CONNECTION'),
    await $.env.get('SSH_CLIENT'),
  ]
  return !elsewhere.some(Boolean)
}

const decodedSize = (base64: string) => Math.floor((base64.length * 3) / 4) - (base64.match(/=*$/)?.[0].length ?? 0)

/**
 * What an Image is sent. A file name draws only where the terminal can open
 * the file, so it goes only to a terminal on this machine. Elsewhere (over
 * ssh, or in tmux, where a client may be attached from another machine) the
 * picture's own bytes go: the PNG, or past the 2 MiB an Image takes, the
 * small pixel copy.
 */
async function sourceFor($: EngineInterface, picture: Picture, local: boolean): Promise<ImageSource> {
  const named: ImageSource = { file: picture.png, format: 'png' }
  if (local) return named
  if (!sentCache.has(picture.png)) {
    const read = await $.fs.read(picture.png, { as: 'bytes' }).catch(() => undefined)
    const png = read === undefined ? undefined : (read as { base64: string }).base64
    let source: ImageSource = named
    if (png !== undefined && decodedSize(png) <= MAX_IMAGE_BYTES) {
      source = { png }
    } else {
      const pixels = await readPixels($, picture.pixels, picture.format, picture.width, picture.height)
      if (pixels !== undefined) source = { rgba: pixels.rgba.toBase64(), width: pixels.width, height: pixels.height }
    }
    sentCache.set(picture.png, source)
  }
  return sentCache.get(picture.png) ?? named
}

/** The engine's own row, with the pictures filed under `keys` drawn below it. */
async function withPictures(
  $: EngineInterface,
  e: any,
  next: (e: any) => Promise<any>,
  settings: Settings,
  keys: string[],
  promptText?: string,
) {
  if (e.surface !== 'terminal') return next(e)
  const pictures = await picturesFor($, keys, promptText)
  const row = await next(e)
  if (pictures.length === 0) return row

  const { Box, Image, Raster, Text } = $.ui.resolve(e)
  const renderer = await rendererFor($, settings)
  const local = renderer === 'pixels' && (await onThisMachine($))
  const room = Math.max(1, (e.viewport?.columns ?? 80) - 6)

  const drawn = []
  for (const picture of pictures) {
    const { width, height } = picture.original
    const natural = Math.max(MIN_COLUMNS, Math.ceil(width / 4))
    const { columns, rows } = fitCells(width, height, Math.min(settings.maxColumns, room, natural), settings.maxRows)
    const caption = `image ${picture.n} · ${width}×${height} · /image ${picture.n}`

    if (renderer === 'pixels') {
      drawn.push(
        <Box key={`picture-${picture.n}`} flexDirection="column" paddingLeft={2}>
          <Image key={`image-${picture.n}`} source={await sourceFor($, picture, local)} columns={columns} rows={rows} alt={`[${caption}]`} />
          <Text dimColor>{caption}</Text>
        </Box>,
      )
      continue
    }
    const cells = await cellsFor($, picture, columns, rows, renderer)
    drawn.push(
      <Box key={`picture-${picture.n}`} flexDirection="column" paddingLeft={2}>
        {cells === undefined ? (
          <Text dimColor>[image {picture.n} could not be read]</Text>
        ) : (
          <Raster key={`cells-${picture.n}`} columns={columns} rows={rows} cells={cells} />
        )}
        <Text dimColor>{caption}</Text>
      </Box>,
    )
  }

  return (
    <Box flexDirection="column">
      {row}
      {drawn}
    </Box>
  )
}

async function openInViewer($: EngineInterface, path: string) {
  for (const opener of ['open', 'xdg-open']) {
    if ((await run($, [opener, path])) !== undefined) return true
  }
  return false
}

const listing = () =>
  catalog.length === 0
    ? 'No images in this conversation yet.'
    : [
        ...[...catalog].sort((a, b) => a.n - b.n).map(picture => `image ${picture.n} · ${picture.original.width}×${picture.original.height}`),
        'Open one full size with /image <number>, or /image last.',
      ].join('\n')

async function answerImage($: EngineInterface, args: string) {
  const wanted = args.trim().toLowerCase()
  if (wanted === '' || wanted === 'list') return { text: listing() }

  const picture = wanted === 'last' ? [...catalog].sort((a, b) => a.n - b.n).at(-1) : catalog.find(one => String(one.n) === wanted.replace(/^#/, ''))
  if (picture === undefined) return { text: `There is no image ${args.trim()}.\n${listing()}` }

  const { width, height } = picture.original
  return (await openInViewer($, picture.png))
    ? { text: `Opened image ${picture.n} (${width}×${height}) in your image viewer.` }
    : { text: `Could not open an image viewer for image ${picture.n}. It is saved at ${picture.png}` }
}

export const register: Register = (on, options) => {
  const renderer = String(options.renderer ?? 'auto')
  const settings: Settings = {
    renderer: renderer === 'pixels' || renderer === 'symbols' || renderer === 'blocks' ? renderer : 'auto',
    maxColumns: Math.max(1, Number(options.maxColumns ?? 64)),
    maxRows: Math.max(1, Number(options.maxRows ?? 22)),
  }

  on('session.start', async ($, e, next) => {
    history = undefined
    await $.command.register({
      name: 'image',
      description: 'Open an image from this conversation at full size (/image 3, /image last), or list them (/image)',
      argumentHint: '[number|last]',
    })
    // Decodes are named by content, so a week-old one is only ever a leftover.
    const dir = await dirFor($)
    void $.process.run(['find', dir, '-type', 'f', '-mtime', '+7', '-delete']).catch(() => undefined)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    history = undefined
    if (e.reason === 'clear') {
      // A cleared conversation starts its numbering over; the decodes on disk stay.
      added = 0
      catalog.length = 0
      byKey.clear()
      byContent.clear()
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined) {
      const found = imagesOf(rowKey(e.uuid), e.message.content)
      const byRow = new Map<string, Found[]>()
      for (const one of found) byRow.set(one.key, [...(byRow.get(one.key) ?? []), one])
      await Promise.all([...byRow].map(([key, group]) => remember($, key, group)))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'SendUserFile' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) {
      const paths = sentImages(ran.result)
      if (paths.length > 0) await remember($, e.tool_use_id, paths.map(path => ({ path })))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'image' }, ($, e) => answerImage($, e.args))

  on('ui.render', { component: 'UserMessage' }, ($, e, next) =>
    withPictures($, e, next, settings, [rowKey(e.requestId)], e.props.text),
  )

  on('ui.render', { component: 'ToolResult' }, ($, e, next) =>
    withPictures($, e, next, settings, [e.props.tool_use_id]),
  )

  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    withPictures($, e, next, settings, e.props.calls.flatMap(call => (call.tool_use_id ? [call.tool_use_id] : []))),
  )
}

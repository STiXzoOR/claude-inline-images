import type { EngineInterface, ImageSource, Register } from 'claude-code'

import { decodeBmp } from './bmp'
import { crispFactor, cropRect, fitView, navigatorBox, panBy, pointerAt, step, thumbWindow, zoomAt } from './lightbox'
import type { Stage, View } from './lightbox'
import type { PadMessage } from './pad'
import type { TapMessage } from './tap'
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
// The lightbox pane, and how far a key or button zooms; a wheel tick zooms less.
const LIGHTBOX = 'lightbox'
const ZOOM_STEP = 2
const WHEEL_STEP = 1.1

// Every picture this load has decoded, numbered in the order it met them.
const catalog: Picture[] = []
const byContent = new Map<string, Promise<Picture | undefined>>()
const byKey = new Map<string, Picture[]>()
const pixelCache = new Map<string, Pixels | null>()
const cellCache = new Map<string, string>()
const sentCache = new Map<string, ImageSource>()
// Crops and navigators made so far, by path; a failed one is not kept, so it is tried again.
const cropsMade = new Map<string, Decoded>()
const navigatorsMade = new Set<string>()
// The last crop and navigator shown, kept on screen while the next are made.
let lastCrop: { n: number; crop: Decoded } | undefined
let lastNavigator: { n: number; path: string } | undefined
// The one loop making crops, if it is running.
let working: Promise<void> | undefined
// The open lightbox: which picture and how it is viewed; the view a drag
// started from; where the picture sits in the pane, for the wheel.
let lightbox: { n: number; view: View } | undefined
let dragFrom: { gesture: number; view: View } | undefined
// The header takes the pane's first row.
let stage: Stage = { top: 1, left: 0, columns: 1, rows: 1 }
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
      const typed = promptText === undefined ? undefined : `prompt:${promptText.trim()}`
      // A prompt typed mid-turn: its pictures were filed by text when it was submitted.
      const submitted = typed === undefined ? undefined : byKey.get(typed)
      if (submitted !== undefined) byKey.set(key, submitted)
      const sources = submitted === undefined ? (loaded.index.get(key) ?? (typed === undefined ? undefined : loaded.index.get(typed))) : undefined
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

async function cellsFor($: EngineInterface, picture: Decoded, columns: number, rows: number, renderer: Renderer) {
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
async function sourceFor($: EngineInterface, picture: Decoded, local: boolean): Promise<ImageSource> {
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

  const { Box, Button, Image, Raster, Text } = $.ui.resolve(e)
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
          {captionButton($, Button, Text, picture.n, caption)}
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
        {captionButton($, Button, Text, picture.n, caption)}
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

/** One picture of the prompt being submitted, its slices joined. */
async function submittedImage($: EngineInterface, id: string) {
  let data = ''
  let mediaType = 'image/png'
  for (let offset: number | undefined = 0; offset !== undefined;) {
    const slice = await $.prompt.media({ id, offset })
    if (slice.unreadable !== undefined || slice.deny !== undefined) return undefined
    data += slice.base64
    mediaType = slice.mediaType
    offset = slice.next
  }
  return { mediaType, data }
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
        'Open one with /image <number>, or /image for the latest.',
      ].join('\n')

/** A caption that opens its picture in the lightbox when pressed or clicked. */
function captionButton($: EngineInterface, Button: any, Text: any, n: number, caption: string) {
  return (
    <Button key={`open-${n}`} plain onPress={() => void openLightbox($, n)}>
      <Text dimColor>{caption}</Text>
    </Button>
  )
}

/** Opens the lightbox at picture `n`. Call it before any await, so the pane is placed at any width. */
function openLightbox($: EngineInterface, n: number) {
  lightbox = { n, view: fitView() }
  dragFrom = undefined
  const opened = $.ui.open({ id: LIGHTBOX, title: 'Images', focus: true, closeOnEscape: true, holdToasts: true, rows: 200, backgroundColor: 'transparent' })
  $.ui.invalidate('ui.render')
  return opened
}

/** Moves the lightbox, and resolves once the crop the new view needs is made. */
function changeLightbox($: EngineInterface, next: { n?: number; view?: View }) {
  if (lightbox === undefined) return Promise.resolve()
  lightbox = { ...lightbox, ...next }
  $.ui.invalidate('ui.render')
  return prepare($)
}

// The pad's keys (arrows, + and -, once a click gave it the focus) and the
// toolbar's hotkeys, as lightbox actions.
const PAD_KEYS: Record<string, string> = {
  right: 'next',
  left: 'previous',
  up: 'pan-up',
  down: 'pan-down',
  '+': 'zoom-in',
  '=': 'zoom-in',
  '-': 'zoom-out',
  _: 'zoom-out',
  '0': 'fit',
  n: 'next',
  p: 'previous',
  z: 'zoom-in',
  x: 'zoom-out',
  f: 'fit',
  w: 'pan-up',
  a: 'pan-left',
  s: 'pan-down',
  d: 'pan-right',
  v: 'viewer',
  q: 'close',
}
const PAN = 0.25

async function actLightbox($: EngineInterface, action: string) {
  if (lightbox === undefined) return
  const { view } = lightbox
  const numbers = catalog.map(picture => picture.n)
  switch (action) {
    case 'next':
    case 'previous':
      return changeLightbox($, { n: step(numbers, lightbox.n, action === 'next' ? 1 : -1), view: fitView() })
    case 'zoom-in':
      return changeLightbox($, { view: zoomAt(view, ZOOM_STEP) })
    case 'zoom-out':
      return changeLightbox($, { view: zoomAt(view, 1 / ZOOM_STEP) })
    case 'fit':
      return changeLightbox($, { view: fitView() })
    case 'pan-up':
      return changeLightbox($, { view: panBy(view, 0, -PAN) })
    case 'pan-down':
      return changeLightbox($, { view: panBy(view, 0, PAN) })
    case 'pan-left':
      return changeLightbox($, { view: panBy(view, -PAN, 0) })
    case 'pan-right':
      return changeLightbox($, { view: panBy(view, PAN, 0) })
    case 'viewer': {
      const picture = catalog.find(one => one.n === lightbox?.n)
      if (picture !== undefined) await openInViewer($, picture.png)
      return
    }
    default: {
      const n = Number(/^go-(\d+)$/.exec(action)?.[1])
      if (catalog.some(one => one.n === n)) return changeLightbox($, { n, view: fitView() })
      return
    }
    case 'close':
      lightbox = undefined
      $.ui.invalidate('ui.render')
      return $.ui.close({ id: LIGHTBOX })
  }
}

/** Where the crop of `picture` for `view` goes, and how much it is enlarged, for a stage `columns` wide. */
function cropFor(picture: Picture, view: View, columns: number) {
  const rect = cropRect(view, picture.original.width, picture.original.height)
  // Enlarged by nearest neighbour, so the terminal's own scaling has no blur to add.
  const factor = crispFactor(rect.width, columns)
  const base = `${picture.png.replace(/\.png$/, '')}.crop-${rect.x}-${rect.y}-${rect.width}-${rect.height}-${factor}`
  return { rect, factor, base }
}

/** Makes the part of a picture a zoomed view shows, decoded like a picture of its own. */
async function makeCrop($: EngineInterface, picture: Picture, job: ReturnType<typeof cropFor>) {
  const { rect, factor, base } = job
  const argv = [
    'magick',
    picture.png,
    '-crop',
    `${rect.width}x${rect.height}+${rect.x}+${rect.y}`,
    '+repage',
    ...(factor > 1 ? ['-filter', 'point', '-resize', `${factor * 100}%`] : []),
    // Light compression: a crop is written on every zoom step.
    '-define',
    'png:compression-level=1',
    '-write',
    `png:${base}.png`,
    '-resize',
    `${CELL_SOURCE}x${CELL_SOURCE}>`,
    '-depth',
    '8',
    '-write',
    `rgba:${base}.rgba`,
    '-format',
    '%w %h',
    'info:',
  ]
  const ran = await $.process.run(argv, { timeoutMs: DECODE_TIMEOUT_MS }).catch(() => undefined)
  const [width = 0, height = 0] = ran?.exitCode === 0 ? ran.stdout.trim().split(/\s+/).map(Number) : []
  if (!(width > 0 && height > 0)) return undefined
  const crop: Decoded = { png: `${base}.png`, pixels: `${base}.rgba`, format: 'rgba', width, height, original: { width: rect.width, height: rect.height } }
  return crop
}

// The navigator's overview, in pixels across.
const NAVIGATOR_PIXELS = 240

/** Where the navigator of `picture` for `view` goes, and its size in pixels. */
function navigatorFor(picture: Picture, view: View) {
  const { width, height } = picture.original
  const w = NAVIGATOR_PIXELS
  const h = Math.max(1, Math.round((NAVIGATOR_PIXELS * height) / width))
  const box = navigatorBox(view, w, h)
  return { w, h, box, path: `${picture.png.replace(/\.png$/, '')}.nav-${box.x0}-${box.y0}-${box.x1}-${box.y1}.png` }
}

/** Makes the whole picture small, the part in view boxed in Claude's orange and the rest dimmed. */
async function makeNavigator($: EngineInterface, picture: Picture, job: ReturnType<typeof navigatorFor>) {
  const { w, h, path } = job
  const { x0, y0, x1, y1 } = job.box
  const shade = [
    `rectangle 0,0 ${w - 1},${y0 - 1}`,
    `rectangle 0,${y1 + 1} ${w - 1},${h - 1}`,
    `rectangle 0,${y0} ${x0 - 1},${y1}`,
    `rectangle ${x1 + 1},${y0} ${w - 1},${y1}`,
  ].join(' ')
  const argv = [
    'magick',
    picture.png,
    '-resize',
    `${w}x${h}!`,
    '-fill',
    'rgba(0,0,0,0.55)',
    '-stroke',
    'none',
    '-draw',
    shade,
    '-fill',
    'none',
    '-stroke',
    '#d97757',
    '-strokewidth',
    '3',
    '-draw',
    `rectangle ${x0},${y0} ${x1},${y1}`,
    '-define',
    'png:compression-level=1',
    `png:${path}`,
  ]
  const ran = await $.process.run(argv, { timeoutMs: DECODE_TIMEOUT_MS }).catch(() => undefined)
  return ran?.exitCode === 0
}

/**
 * Makes the crop and navigator the open view needs, one at a time, always for
 * the latest view: views passed while one was being made are skipped. Runs in
 * the input's own hook, never a render's, whose replacement would kill it.
 */
function prepare($: EngineInterface): Promise<void> {
  // Cleared once the loop has ended, never before it is set: a loop with
  // nothing to do ends at once.
  working ??= makeWanted($).finally(() => {
    working = undefined
  })
  return working
}

async function makeWanted($: EngineInterface) {
  let tried = ''
  for (;;) {
    const picture = lightbox === undefined ? undefined : catalog.find(one => one.n === lightbox?.n)
    if (lightbox === undefined || picture === undefined || lightbox.view.zoom <= 1 || hasMagick === false) return
    const crop = cropFor(picture, lightbox.view, stage.columns)
    const navigator = navigatorFor(picture, lightbox.view)
    const needsCrop = !cropsMade.has(crop.base)
    const needsNavigator = stage.columns >= 24 && !navigatorsMade.has(navigator.path)
    const job = `${crop.base} ${navigator.path}`
    // Done, or this one just failed: the next input tries it again.
    if ((!needsCrop && !needsNavigator) || job === tried) return
    tried = job
    if (needsCrop) {
      const made = await makeCrop($, picture, crop)
      if (made !== undefined) cropsMade.set(crop.base, made)
    }
    if (needsNavigator && (await makeNavigator($, picture, navigator))) navigatorsMade.add(navigator.path)
    $.ui.invalidate('ui.render')
  }
}

const zoomLabel = (zoom: number) => (zoom === 1 ? 'fit' : `${Number(zoom.toFixed(1))}×`)

// A thumbnail's room inside its frame, and the frame's with its border and number.
// An odd height, so the arrows beside the frames sit on their middle row.
const THUMB = { columns: 12, rows: 5 }
const FRAME = { columns: THUMB.columns + 2, rows: THUMB.rows + 2 }
// The strip of thumbnails takes the frame and a row of numbers; the stage keeps at least this many rows.
const STRIP_ROWS = FRAME.rows + 1
const MIN_STAGE_ROWS = 8

/** The lightbox pane: a header, the picture with the pad over it, the strip of pictures and a key hint. */
async function drawLightbox($: EngineInterface, e: any, settings: Settings) {
  const { Box, Button, Client, Image, Raster, Text } = $.ui.resolve(e)
  const picture = lightbox === undefined ? undefined : catalog.find(one => one.n === lightbox?.n)
  if (lightbox === undefined || picture === undefined) return <Text dimColor>No image open. /image lists them.</Text>

  const renderer = await rendererFor($, settings)
  const local = renderer === 'pixels' && (await onThisMachine($))
  const numbers = catalog.map(one => one.n).sort((a, b) => a - b)
  const bodyColumns = Math.max(8, Number(e.props?.bodyColumns ?? 80))
  const bodyRows = Number(e.props?.scroll?.bodyRows ?? 24)
  // The header and the hint take a row each; thumbnails where the pane is tall enough, else numbers.
  const thumbs = numbers.length > 1 && bodyRows - 2 - STRIP_ROWS >= MIN_STAGE_ROWS
  const stripRows = numbers.length > 1 ? (thumbs ? STRIP_ROWS : 1) : 0
  const room = { columns: bodyColumns, rows: Math.max(3, bodyRows - 2 - stripRows) }

  const { width, height } = picture.original
  // The stage is the whole picture at fit, never bigger than its own pixels
  // (a cell taken as 8x16); a zoomed view shows less of it in the same room.
  const { columns, rows } = fitCells(
    width,
    height,
    Math.min(room.columns, Math.max(MIN_COLUMNS, Math.ceil(width / 8))),
    Math.min(room.rows, Math.max(1, Math.ceil(height / 16))),
  )
  stage = { top: 1, left: Math.floor((room.columns - columns) / 2), columns, rows }

  const zoomed = lightbox.view.zoom > 1
  // The crop this view needs once it is made; till then the last one shown.
  let shown: Decoded = picture
  if (zoomed) {
    const made = cropsMade.get(cropFor(picture, lightbox.view, columns).base)
    if (made !== undefined) lastCrop = { n: picture.n, crop: made }
    shown = made ?? (lastCrop?.n === picture.n ? lastCrop.crop : picture)
  }
  const alt = `[image ${picture.n}]`
  let body
  if (renderer === 'pixels') {
    body = <Image key="lightbox-image" source={await sourceFor($, shown, local)} columns={columns} rows={rows} alt={alt} />
  } else {
    const cells = await cellsFor($, shown, columns, rows, renderer)
    body = cells === undefined ? <Text dimColor>{alt}</Text> : <Raster key="lightbox-cells" columns={columns} rows={rows} cells={cells} />
  }

  // The navigator: in the stage's top right corner while zoomed in, real pixels only.
  let navigator
  if (zoomed && renderer === 'pixels' && columns >= 24) {
    const wanted = navigatorFor(picture, lightbox.view).path
    if (navigatorsMade.has(wanted)) lastNavigator = { n: picture.n, path: wanted }
    const path = navigatorsMade.has(wanted) ? wanted : lastNavigator?.n === picture.n ? lastNavigator.path : undefined
    const size = fitCells(width, height, Math.max(8, Math.round(columns / 4)), Math.max(3, Math.round(rows / 3)))
    if (path !== undefined) {
      navigator = (
        <Box position="absolute" top={0} right={0} borderStyle="round" borderColor="subtle">
          <Image key="navigator" source={{ file: path, format: 'png' }} columns={size.columns} rows={size.rows} alt="[navigator]" />
        </Box>
      )
    }
  }

  const control = (key: string, hotkey: string, label: string, action = key) => (
    <Button key={key} hotkey={hotkey} plain onPress={() => actLightbox($, action)}>
      {label}
    </Button>
  )
  // The strip's arrows: bracketed buttons, centred on the thumbnails.
  const arrow = (key: string, action: string, label: string, rows: number) => (
    <Box flexDirection="column" height={rows} justifyContent="center">
      <Button key={key} onPress={() => actLightbox($, action)}>
        {label}
      </Button>
    </Box>
  )
  // Clickable, with no hotkey, so the terminal draws the label alone.
  const link = (key: string, action: string, label: string, current = false) => (
    <Button key={key} plain onPress={() => actLightbox($, action)}>
      <Text color={current ? 'claude' : 'subtle'} bold={current}>
        {label}
      </Text>
    </Button>
  )

  let strip
  if (thumbs) {
    // ❮ and ❯ take six columns each with their gaps; a frame and a gap thirteen.
    const shownNumbers = thumbWindow(numbers, picture.n, Math.max(1, Math.floor((room.columns - 12) / (FRAME.columns + 1))))
    const frames = []
    for (const n of shownNumbers) {
      const one = catalog.find(candidate => candidate.n === n)
      if (one === undefined) continue
      const size = fitCells(one.original.width, one.original.height, THUMB.columns, THUMB.rows)
      let thumb
      if (renderer === 'pixels') {
        thumb = <Image key={`thumb-${n}`} source={await sourceFor($, one, local)} columns={size.columns} rows={size.rows} alt={`[${n}]`} />
      } else {
        const cells = await cellsFor($, one, size.columns, size.rows, renderer)
        thumb = cells === undefined ? <Text dimColor>{`[${n}]`}</Text> : <Raster key={`thumb-${n}`} columns={size.columns} rows={size.rows} cells={cells} />
      }
      const current = n === picture.n
      frames.push(
        <Box key={`slot-${n}`} flexDirection="column" width={FRAME.columns}>
          <Box
            key={`frame-${n}`}
            flexDirection="row"
            width={FRAME.columns}
            height={FRAME.rows}
            borderStyle="round"
            borderColor={current ? 'claude' : 'subtle'}
            borderDimColor={!current}
            justifyContent="center"
            alignItems="center"
          >
            <Box width={size.columns} height={size.rows}>
              {thumb}
              {/* A click on a thumbnail opens it. Real pixels only: a Client over a Raster blanks it. */}
              {renderer === 'pixels' && !current && (
                <Box position="absolute" top={0} left={0}>
                  <Client key={`tap-${n}`} module="./tap.tsx" width={size.columns} height={size.rows} props={{ n, columns: size.columns, rows: size.rows }} />
                </Box>
              )}
            </Box>
          </Box>
          <Box flexDirection="row" width={FRAME.columns} justifyContent="center">
            {link(`go-${n}`, `go-${n}`, String(n), current)}
          </Box>
        </Box>,
      )
    }
    strip = (
      <Box flexDirection="row" justifyContent="center" alignItems="flex-start" columnGap={1} width={room.columns}>
        {arrow('strip-previous', 'previous', '❮', FRAME.rows)}
        {frames}
        {arrow('strip-next', 'next', '❯', FRAME.rows)}
      </Box>
    )
  } else if (numbers.length > 1) {
    const shownNumbers = thumbWindow(numbers, picture.n, 9)
    strip = (
      <Box flexDirection="row" justifyContent="center" columnGap={2} width={room.columns}>
        {arrow('strip-previous', 'previous', '❮', 1)}
        {shownNumbers[0] !== numbers[0] && <Text dimColor>…</Text>}
        {shownNumbers.map(n => link(`go-${n}`, `go-${n}`, String(n), n === picture.n))}
        {shownNumbers.at(-1) !== numbers.at(-1) && <Text dimColor>…</Text>}
        {arrow('strip-next', 'next', '❯', 1)}
      </Box>
    )
  }

  const zoomNote = zoomed && hasMagick === false ? ' · zoom needs ImageMagick' : ''
  const hint = [
    numbers.length > 1 ? 'n/p step' : undefined,
    'scroll or z/x zoom',
    renderer === 'pixels' ? 'drag or w a s d pan' : 'w a s d pan',
    'f fit',
    'v open',
    'esc close',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <Box flexDirection="column" width={room.columns}>
      <Box flexDirection="row" justifyContent="space-between" width={room.columns}>
        <Text bold>{`image ${picture.n} of ${catalog.length}`}</Text>
        <Box flexDirection="row" columnGap={2}>
          <Text dimColor>{`${width}×${height} · ${zoomLabel(lightbox.view.zoom)}${zoomNote}`}</Text>
          <Button key="close-button" onPress={() => actLightbox($, 'close')}>
            ✕ close
          </Button>
        </Box>
      </Box>
      <Box flexDirection="row" justifyContent="center" width={room.columns}>
        <Box key="stage" width={columns} height={rows}>
          {body}
          {navigator}
          {/* The pad takes clicks, drags and keys over real pixels. Over block
              symbols it would blank them, so there the wheel and hotkeys drive. */}
          {renderer === 'pixels' && (
            <Box position="absolute" top={0} left={0}>
              <Client key="pad" module="./pad.tsx" width={columns} height={rows} props={{ columns, rows }} />
            </Box>
          )}
        </Box>
      </Box>
      {strip}
      <Text dimColor wrap="truncate">
        {hint}
      </Text>
      <Box display="none">
        {control('previous', 'p', 'prev')}
        {control('next', 'n', 'next')}
        {control('zoom-out', 'x', 'zoom out')}
        {control('zoom-in', 'z', 'zoom in')}
        {control('fit', 'f', 'fit')}
        {control('viewer', 'v', 'viewer')}
        {control('pan-up', 'w', 'up')}
        {control('pan-left', 'a', 'left')}
        {control('pan-down', 's', 'down')}
        {control('pan-right', 'd', 'right')}
        {control('fit-0', '0', 'fit', 'fit')}
        {control('close', 'q', 'close')}
      </Box>
    </Box>
  )
}

function answerImage($: EngineInterface, args: string) {
  const wanted = args.trim().toLowerCase()
  if (wanted === 'list') return { text: listing() }

  const latest = [...catalog].sort((a, b) => a.n - b.n).at(-1)
  const picture = wanted === '' || wanted === 'last' ? latest : catalog.find(one => String(one.n) === wanted.replace(/^#/, ''))
  if (picture === undefined) return { text: catalog.length === 0 ? listing() : `There is no image ${args.trim()}.\n${listing()}` }

  void openLightbox($, picture.n)
  return { text: `Image ${picture.n} is open in the lightbox. Esc closes it.` }
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
      description: 'Open an image of this conversation in a lightbox (/image 3, or /image for the latest), or list them (/image list)',
      argumentHint: '[number|last|list]',
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

  // A prompt typed mid-turn is stored as text alone: its pictures reach the
  // model but never session.append. Read them while it is being submitted and
  // file them under its text, which the row it draws as carries.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId !== undefined) {
      const sources = []
      for (const item of e.attachments ?? []) {
        if (item.type === 'image' && item.id !== undefined) {
          const read = await submittedImage($, item.id)
          if (read !== undefined) sources.push(read)
        }
      }
      if (sources.length > 0) await remember($, `prompt:${e.text.trim()}`, sources)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: LIGHTBOX }, ($, e) => drawLightbox($, e, settings))

  on('ui.message', async ($, e, next) => {
    const data = e.data as PadMessage | TapMessage | undefined
    if (data?.type === 'tap' && catalog.some(one => one.n === data.n)) changeLightbox($, { n: data.n, view: fitView() })
    if (data?.type === 'key' && PAD_KEYS[data.key] !== undefined) await actLightbox($, PAD_KEYS[data.key]!)
    if (data?.type === 'drag' && lightbox !== undefined) {
      if (dragFrom?.gesture !== data.gesture) dragFrom = { gesture: data.gesture, view: lightbox.view }
      changeLightbox($, { view: panBy(dragFrom.view, data.dx, data.dy) })
      if (data.done) dragFrom = undefined
    }
    return next(e)
  })

  // The wheel or trackpad over the picture zooms about the pointer; the up and
  // down keys, which carry no pointer, step through the pictures. The pane
  // itself never scrolls.
  on('ui.scroll', { requestId: LIGHTBOX }, ($, e) => {
    if (lightbox === undefined) return {}
    if (e.origin.kind !== 'person') return {}
    if (e.pointer === undefined) {
      void actLightbox($, e.by < 0 ? 'previous' : 'next')
      return {}
    }
    changeLightbox($, { view: zoomAt(lightbox.view, WHEEL_STEP ** -e.by, pointerAt(e.pointer, stage)) })
    return {}
  })

  on('ui.close', ($, e, next) => {
    if (e.id === LIGHTBOX) {
      lightbox = undefined
      dragFrom = undefined
    }
    return next(e)
  })

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

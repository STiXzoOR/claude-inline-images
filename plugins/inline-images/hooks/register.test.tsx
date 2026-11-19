import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'inline-images'
const VIEWPORT = { columns: 100, rows: 40 }
const TMP = '/tmp/test-tmp'
// A 2x2 picture, red on the left and blue on the right.
const LEFT_RED = Uint8Array.from([0xff, 0, 0, 0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0xff, 0, 0, 0xff, 0xff])
// One cell wide, so `symbols` splits it down the middle and `blocks` cannot.
const ONE_CELL = { maxColumns: 1 }
// The decoded PNG, as the mock file system hands it back: a 2x2 red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAA1BMVEX/AAAZ4gk3AAAADElEQVQI12NgYGAAAAAEAAEnNCcKAAAAAElFTkSuQmCC'

/** The same picture as a top-down 32-bit BMP, as `sips` writes it. */
const leftRedBmp = () => {
  const bytes = new Uint8Array(54 + 16)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, 2, true)
  view.setInt32(22, -2, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 32, true)
  bytes.set([0, 0, 0xff, 0xff, 0xff, 0, 0, 0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0, 0xff], 54)
  return bytes
}

type World = {
  terminal?: string
  hasMagick?: boolean
  canDecode?: boolean
  history?: unknown[]
  env?: Record<string, string>
  png?: string
  /** What magick prints for a decode: the picture's size, then the pixel copy's. */
  decoded?: string
  /** How many crops fail before they work. */
  cropFails?: number
  /** Asked before each crop: a promise holds it until it resolves. */
  cropGate?: () => Promise<void> | undefined
}
type Run = { argv: readonly string[]; stdin?: string }

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const failed = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }

const world = (
  on: On,
  { terminal = 'WarpTerminal', hasMagick = true, canDecode = true, history = [], env = {}, png = PNG, decoded = '2 2 2 2', cropFails = 0, cropGate }: World = {},
) => {
  const runs: Run[] = []
  const files = new Map<string, string>()
  mock.env(on, { TERM_PROGRAM: terminal, TMPDIR: `${TMP}/`, ...env })

  opened.length = 0
  openedWith.length = 0
  // The test kit draws no panes: answer opens and closes as a surface placing them.
  on('ui.open', ($, e) => {
    opened.push(e.id)
    openedWith.push(e as Record<string, unknown>)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  let failsLeft = cropFails
  on('process.run', async ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const [command] = e.argv
    if (command === 'magick') {
      if (!hasMagick) return { deny: 'magick: command not found' }
      if (!canDecode) return failed
      if (e.argv.includes('-crop')) {
        if (failsLeft > 0) {
          failsLeft--
          return failed
        }
        await cropGate?.()
        // A crop prints only its pixel copy's size.
        return ok('2 2')
      }
      return ok(decoded)
    }
    if (command === 'sips' || command === '/usr/bin/sips') {
      if (!canDecode) return failed
      return ok(e.argv.includes('-g') ? 'pixelWidth: 2\n  pixelHeight: 2\n' : '')
    }
    return ok()
  })
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    if (e.path.endsWith('.rgba')) return { value: { base64: LEFT_RED.toBase64() } }
    if (e.path.endsWith('.bmp')) return { value: { base64: leftRedBmp().toBase64() } }
    if (e.path.endsWith('.png')) return { value: { base64: png } }
    const text = files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 1, isLink: false } }))
  // Like the engine, every read hands back fresh copies of the messages.
  on('session.messages', () => ({ value: structuredClone(history) as never }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine row</Text>
  })

  return runs
}

const image = (data: string, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })

const pasted = ($: Engine, uuid: string, data = 'AAAA') =>
  $.session.append({
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid,
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'what is this [Image #1]' }, image(data)] },
  })

const toolImage = ($: Engine, toolUseId: string) =>
  $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    uuid: `9b76ac11-8348-4e1f-8b7f-${toolUseId.padEnd(12, '0').slice(0, 12)}`,
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [image('BBBB', 'image/jpeg')] }],
    },
  })

const UUID = '6c522156-904f-4532-9436-9889a1e9386d'
const BLOCK_ID = '6c522156-904f-4532-9436-000000000000'
const PROMPT_ROW = { text: 'what is this [Image #1]', origin: { kind: 'composer' as const }, isExpanded: false }

const mountPrompt = ($: Engine, requestId = BLOCK_ID, props = PROMPT_ROW, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: PLUGIN, surface, component: 'UserMessage', props, requestId, viewport: VIEWPORT })

const firstCode = (cells: unknown) => new DataView(Uint8Array.fromBase64(String(cells)).buffer).getUint32(0, true)

test('draws a pasted image under its prompt, sharpened with block symbols in Warp', { options: ONE_CELL }, async ($, on) => {
  world(on)
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
  const raster = await ui.find({ type: 'Raster' })
  expect(firstCode(raster?.props.cells)).toBe(0x258c)
})

test('captions each image with its number, so /image can open it', async ($, on) => {
  world(on)
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect(await ui.find({ type: 'Text', text: /image 1 · 2×2 · \/image 1/ })).toBeDefined()
})

test('the blocks renderer draws plain half blocks', { options: { ...ONE_CELL, renderer: 'blocks' } }, async ($, on) => {
  world(on)
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect(firstCode((await ui.find({ type: 'Raster' }))?.props.cells)).toBe(0x20)
})

// ImageMagick 7.1.2 refuses `inline:-` (a data URI on stdin) as a policy
// error, so pasted bytes go through a file. Linux has no sips to fall back on.
test('writes pasted image bytes to a file and hands magick its path', async ($, on) => {
  const runs = world(on)
  await pasted($, UUID)

  const write = runs.find(run => run.argv[0] === 'sh')
  const magick = runs.find(run => run.argv[0] === 'magick')
  expect(write?.argv.slice(0, 3)).toEqual(['sh', '-c', 'base64 -d >"$1"'])
  expect(write?.stdin).toBe('AAAA')
  expect(write?.argv[4]).toMatch(/\/claude-inline-images\/[0-9a-f]+\.src$/)
  expect(magick?.argv[1]).toBe(write?.argv[4])
  expect(magick?.stdin).toBeUndefined()
})

test('decodes an image seen twice only once', async ($, on) => {
  const runs = world(on)
  await pasted($, UUID, 'SAME')
  await pasted($, '11111111-2222-3333-4444-555555555555', 'SAME')

  const ui = await mountPrompt($, '11111111-2222-3333-4444-000000000000')

  expect(runs.filter(run => run.argv[0] === 'magick')).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /image 1 ·/ })).toBeDefined()
})

test('leaves a row with no image as the engine draws it', async ($, on) => {
  world(on)

  const ui = await mountPrompt($, 'no-image')

  expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
})

test('draws real pixels where Claude Code draws pictures, as in Ghostty', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await pasted($, UUID)

  const ui = await mountPrompt($)

  const source = (await ui.find({ type: 'Image' }))?.props.source as { file?: string; format?: string } | undefined
  expect(source?.format).toBe('png')
  expect(source?.file).toMatch(/\/claude-inline-images\/[0-9a-f]+\.png$/)
})

// A file name draws only where the terminal can open the file. Inside tmux a
// client may be attached from another machine, and over ssh the terminal is on
// another machine, so both get the picture's own bytes.
const FORCED = { CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' }

test('sends the picture itself inside tmux, where a client may sit on another machine', async ($, on) => {
  world(on, { terminal: 'tmux', env: { ...FORCED, TMUX: '/tmp/tmux-0/default,1,0' } })
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
})

test('sends the picture itself over ssh', async ($, on) => {
  world(on, { terminal: 'rex', env: { ...FORCED, SSH_CONNECTION: '203.0.113.5 50022 198.51.100.7 22' } })
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: PNG })
})

test('sends the small pixel copy when the PNG is past the 2 MiB an Image takes', async ($, on) => {
  // 2,800,000 base64 characters are 2,100,000 bytes, just past 2 MiB.
  world(on, { terminal: 'tmux', env: { ...FORCED, TMUX: '/tmp/tmux-0/default,1,0' }, png: 'A'.repeat(2_800_000) })
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ rgba: LEFT_RED.toBase64(), width: 2, height: 2 })
})

test('draws a tool result image under its tool row', async ($, on) => {
  world(on)
  await toolImage($, 'toolu_1')

  const ui = await $.ui.mount({
    plugin: PLUGIN, surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_1', tool: 'Read', output: {}, isErrored: false },
    requestId: 'toolu_1', viewport: VIEWPORT,
  })

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('draws the images of a folded group of reads', async ($, on) => {
  world(on)
  await toolImage($, 'toolu_2')

  const call = { tool_use_id: 'toolu_2', tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }
  const ui = await $.ui.mount({
    plugin: PLUGIN, surface: 'terminal', component: 'ToolGroup',
    props: { calls: [call], isActive: false, isExpanded: false }, viewport: VIEWPORT,
  })

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('draws an image Claude sent with SendUserFile under its row', async ($, on) => {
  const runs = world(on)
  on('tool.call', { tool: 'SendUserFile' }, () => ({
    result: { attachments: [{ path: '/work/shot.png', size: 10, isImage: true, media_type: 'image/png' }] },
  }))

  await $.tool.call({ tool: 'SendUserFile', tool_use_id: 'toolu_sent', files: ['/work/shot.png'], status: 'normal' })
  const ui = await $.ui.mount({
    plugin: PLUGIN, surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_sent', tool: 'SendUserFile', output: {}, isErrored: false },
    requestId: 'toolu_sent', viewport: VIEWPORT,
  })

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(runs.find(run => run.argv[0] === 'magick')?.argv).toContain('/work/shot.png')
})

test('falls back to macOS sips when ImageMagick is missing', { options: ONE_CELL }, async ($, on) => {
  const runs = world(on, { hasMagick: false })
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect(runs.some(run => run.argv[0] === 'sips' || run.argv[0] === '/usr/bin/sips')).toBe(true)
  expect(firstCode((await ui.find({ type: 'Raster' }))?.props.cells)).toBe(0x258c)
})

test('draws the row alone when nothing can decode the image', async ($, on) => {
  world(on, { canDecode: false })
  await pasted($, UUID)

  const ui = await mountPrompt($)

  expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
})

test('finds a pasted image of a resumed conversation by its prompt text', async ($, on) => {
  world(on, {
    history: [{ role: 'user', content: [{ type: 'text', text: 'what is this [Image #1]' }, image('OLD')] }],
  })

  const ui = await mountPrompt($, '54cda9b7-46b8-4807-9b2e-000000000000')

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('finds a tool result image of a resumed conversation by its tool_use_id', async ($, on) => {
  world(on, {
    history: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old', content: [image('OLD')] }] }],
  })

  const ui = await $.ui.mount({
    plugin: PLUGIN, surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_old', tool: 'Read', output: {}, isErrored: false },
    requestId: 'toolu_old', viewport: VIEWPORT,
  })

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
})

test('numbers a resumed conversation\'s images in conversation order, whatever order rows draw in', async ($, on) => {
  world(on, {
    history: [
      { role: 'user', content: [{ type: 'text', text: 'what is this [Image #1]' }, image('FIRST')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_later', content: [image('SECOND')] }] },
    ],
  })

  const later = await $.ui.mount({
    plugin: PLUGIN, surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_later', tool: 'Read', output: {}, isErrored: false },
    requestId: 'toolu_later', viewport: VIEWPORT,
  })
  const first = await mountPrompt($, '54cda9b7-46b8-4807-9b2e-000000000000')

  expect(await later.find({ type: 'Text', text: /image 2 ·/ })).toBeDefined()
  expect(await first.find({ type: 'Text', text: /image 1 ·/ })).toBeDefined()
})

test('keeps a resumed conversation\'s numbers when the session starts after its rows drew', async ($, on) => {
  // A resumed session draws its rows first, then raises session.start.
  world(on, {
    history: [
      { role: 'user', content: [{ type: 'text', text: 'what is this [Image #1]' }, image('FIRST')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_later', content: [image('SECOND')] }] },
    ],
  })
  on('command.register', () => ({ value: {} as never }))
  on('session.start', ($, e) => e)

  await mountPrompt($, '54cda9b7-46b8-4807-9b2e-000000000000')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const later = await $.ui.mount({
    plugin: PLUGIN, surface: 'terminal', component: 'ToolResult',
    props: { tool_use_id: 'toolu_later', tool: 'Read', output: {}, isErrored: false },
    requestId: 'toolu_later', viewport: VIEWPORT,
  })

  expect(await later.find({ type: 'Text', text: /image 2 ·/ })).toBeDefined()
})

test('numbers new images after the ones a resumed conversation holds', async ($, on) => {
  world(on, {
    history: [{ role: 'user', content: [{ type: 'text', text: 'an old one [Image #1]' }, image('OLD')] }],
  })
  await pasted($, UUID, 'NEW')

  const ui = await mountPrompt($)

  expect(await ui.find({ type: 'Text', text: /image 2 ·/ })).toBeDefined()
})

const runImage = ($: Engine, args: string) =>
  $.command.run({
    command: 'image',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

const LIGHTBOX = 'lightbox'
const PANE = {
  title: 'Images', isFocused: true, bodyColumns: 80, placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 30 }, view: {},
}

const mountLightbox = ($: Engine) =>
  $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', props: PANE, requestId: LIGHTBOX, viewport: VIEWPORT })

/** The ids of the panes the mod opened since the last world, and how. */
const opened: string[] = []
const openedWith: Record<string, unknown>[] = []

const header = async (ui: Awaited<ReturnType<typeof mountLightbox>>) =>
  (await ui.find({ type: 'Text', text: /^image \d+ of \d+/ }))?.text

/** The header's zoom: `fit`, or how far in. */
const zoom = async (ui: Awaited<ReturnType<typeof mountLightbox>>) =>
  (await ui.find({ type: 'Text', text: /^\d+×\d+ · / }))?.text.split(' · ').at(-1)

/** Two pictures: 1 pasted, 2 from a tool. */
const twoPictures = async ($: Engine) => {
  await pasted($, UUID)
  await toolImage($, 'toolu_1')
}

const crops = (runs: Run[]) => runs.filter(run => run.argv[0] === 'magick' && run.argv.includes('-crop'))

test('/image <n> opens that picture in the lightbox pane', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)

  await runImage($, '2')
  const ui = await mountLightbox($)

  expect(opened).toContain(LIGHTBOX)
  expect(await header(ui)).toMatch(/^image 2 of 2/)
  expect((await ui.find({ type: 'Image' }))?.props.source).toBeDefined()
})

test('the lightbox lets the terminal show through, as Claude Code\'s own panes do', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await pasted($, UUID)

  await runImage($, '1')

  expect(openedWith.at(-1)?.backgroundColor).toBe('transparent')
})

test('never draws a small picture bigger than it is', async ($, on) => {
  // A 100x100 picture is 13 columns of 8 pixels and 7 rows of 16, however big the pane.
  world(on, { terminal: 'ghostty', decoded: '100 100 2 2' })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)

  const image = await ui.find({ type: 'Image' })
  expect(image?.props.columns).toBeLessThanOrEqual(13)
  expect(image?.props.rows).toBeLessThanOrEqual(7)
})

test('shows no hotkey buttons, only the strip to click', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '2')
  const ui = await mountLightbox($)

  await ui.press({ key: 'strip-previous' })
  expect(await header(ui)).toMatch(/^image 1 of 2/)
  await ui.press({ key: 'strip-next' })
  expect(await header(ui)).toMatch(/^image 2 of 2/)
  expect(await ui.find({ type: 'Text', text: /esc close/ })).toBeDefined()
})

test('/image with nothing after it opens the latest picture', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)

  await runImage($, '')
  const ui = await mountLightbox($)

  expect(await header(ui)).toMatch(/^image 2 of 2/)
})

test('/image list lists the pictures of the conversation', async ($, on) => {
  world(on)
  await pasted($, UUID)

  const answer = await runImage($, 'list')

  expect(JSON.stringify(answer)).toMatch(/image 1 · 2×2/)
})

test('steps through the pictures with its buttons, wrapping round', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '2')
  const ui = await mountLightbox($)

  await ui.press({ key: 'next' })
  expect(await header(ui)).toMatch(/^image 1 of 2/)
  await ui.press({ key: 'previous' })
  expect(await header(ui)).toMatch(/^image 2 of 2/)
})

test('zooms in by drawing a crop of the picture, and fit shows it whole again', async ($, on) => {
  const runs = world(on, { terminal: 'ghostty' })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)

  await ui.press({ key: 'zoom-in' })
  expect(await zoom(ui)).toBe('2×')
  expect(crops(runs)).toHaveLength(1)
  expect(String(((await ui.find({ type: 'Image' }))?.props.source as { file?: string } | undefined)?.file)).toMatch(/\.crop-[\d-]+\.png$/)

  // One picture needs no strip of numbers.
  expect(await ui.find({ key: 'go-1' })).toBeUndefined()

  await ui.press({ key: 'fit' })
  expect(String(((await ui.find({ type: 'Image' }))?.props.source as { file?: string } | undefined)?.file)).not.toMatch(/\.crop-/)
})

test('takes arrow keys and + from the pad laid over the picture', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '1')
  const ui = await mountLightbox($)

  await ui.key({ key: 'right', in: 'pad' })
  expect(await header(ui)).toMatch(/^image 2 of 2/)
  await ui.key({ key: '+', in: 'pad' })
  expect(await zoom(ui)).toBe('2×')
})

test('pans a zoomed picture with a drag on the pad', async ($, on) => {
  // A 100x100 picture, so a pan moves the crop by whole pixels.
  const runs = world(on, { terminal: 'ghostty', decoded: '100 100 2 2' })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)
  await ui.press({ key: 'zoom-in' })
  await ui.resize({ columns: 10, rows: 10, in: 'pad' })

  // Dragging the picture right by half the pad shows more of its left side.
  await ui.pointer({ type: 'down', x: 2, y: 5, button: 'left' })
  await ui.pointer({ type: 'move', x: 7, y: 5, button: 'left' })
  await ui.pointer({ type: 'up', x: 7, y: 5, button: 'left' })

  const last = crops(runs).at(-1)?.argv
  expect(last?.[last.indexOf('-crop') + 1]).toBe('50x50+0+25')
})

test('jumps to a picture from the strip of numbers', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '2')
  const ui = await mountLightbox($)
  await ui.press({ key: 'zoom-in' })

  await ui.press({ key: 'go-1' })

  expect(await header(ui)).toMatch(/^image 1 of 2/)
  expect(await zoom(ui)).toBe('fit')
})

test('opens the picture in the system viewer with v', async ($, on) => {
  const runs = world(on, { terminal: 'ghostty' })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)

  await ui.press({ key: 'viewer' })

  expect(runs.find(run => run.argv[0] === 'open')?.argv.at(-1)).toMatch(/\.png$/)
})

test('a click on a caption opens that picture in the lightbox', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await pasted($, UUID)
  const row = await mountPrompt($)

  await row.press({ key: 'open-1' })
  const ui = await mountLightbox($)

  expect(opened).toContain(LIGHTBOX)
  expect(await header(ui)).toMatch(/^image 1 of 1/)
})

test('shows the conversation\'s pictures as thumbnails, the open one framed in Claude\'s colour', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '2')
  const ui = await mountLightbox($)

  expect(await ui.find({ type: 'Image', key: 'thumb-1' })).toBeDefined()
  expect(await ui.find({ type: 'Image', key: 'thumb-2' })).toBeDefined()
  expect((await ui.find({ key: 'frame-2' }))?.props.borderColor).toBe('claude')
  expect((await ui.find({ key: 'frame-1' }))?.props.borderColor).not.toBe('claude')

  await ui.press({ key: 'go-1' })
  expect(await header(ui)).toMatch(/^image 1 of 2/)
})

test('a click on a thumbnail opens that picture', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '2')
  const ui = await mountLightbox($)

  await ui.post({ type: 'tap', n: 1 }, { in: 'tap-1' })

  expect(await header(ui)).toMatch(/^image 1 of 2/)
})

test('falls back to numbers where the pane is too short for thumbnails', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '2')
  const ui = await $.ui.mount({
    plugin: PLUGIN, surface: 'terminal', component: 'Pane',
    props: { ...PANE, scroll: { offset: 0, bodyRows: 12 } }, requestId: LIGHTBOX, viewport: VIEWPORT,
  })

  expect(await ui.find({ key: 'thumb-1' })).toBeUndefined()
  expect(await ui.find({ key: 'go-1' })).toBeDefined()
})

test('shows a navigator with the part in view boxed while zoomed in', async ($, on) => {
  // Big enough that the stage has room for a navigator.
  const runs = world(on, { terminal: 'ghostty', decoded: '1000 1000 2 2' })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)
  expect(await ui.find({ key: 'navigator' })).toBeUndefined()

  await ui.press({ key: 'zoom-in' })

  expect(await ui.find({ type: 'Image', key: 'navigator' })).toBeDefined()
  expect(runs.some(run => run.argv[0] === 'magick' && run.argv.includes('-draw'))).toBe(true)
})

test('enlarges a zoomed crop by nearest neighbour, so its pixels stay sharp', async ($, on) => {
  const runs = world(on, { terminal: 'ghostty', decoded: '100 100 2 2' })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)

  await ui.press({ key: 'zoom-in' })

  const crop = crops(runs).at(-1)?.argv ?? []
  expect(crop[crop.indexOf('-filter') + 1]).toBe('point')
})

const imageFile = async (ui: Awaited<ReturnType<typeof mountLightbox>>) =>
  String(((await ui.find({ type: 'Image', key: 'lightbox-image' }))?.props.source as { file?: string } | undefined)?.file)

test('tries a crop that failed again, and never blames ImageMagick while it is there', async ($, on) => {
  const runs = world(on, { terminal: 'ghostty', decoded: '100 100 2 2', cropFails: 1 })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)

  await ui.press({ key: 'zoom-in' })
  expect(await zoom(ui)).toBe('2×')
  await ui.press({ key: 'fit' })
  await ui.press({ key: 'zoom-in' })

  expect(crops(runs)).toHaveLength(2)
  expect(await imageFile(ui)).toMatch(/\.crop-/)
})

test('keeps the last sharp view on screen while the next crop is made, and makes only the latest', async ($, on) => {
  let hold: Promise<void> | undefined
  let release = () => {}
  const runs = world(on, { terminal: 'ghostty', decoded: '1000 1000 2 2', cropGate: () => hold })
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)
  await ui.press({ key: 'zoom-in' })
  const first = await imageFile(ui)
  expect(first).toMatch(/\.crop-/)
  const before = crops(runs).length

  // Hold the crops, and zoom three more times while one is being made.
  hold = new Promise<void>(resolve => (release = resolve))
  const presses = [ui.press({ key: 'zoom-in' }), ui.press({ key: 'zoom-in' }), ui.press({ key: 'zoom-in' })]
  expect(await imageFile(ui)).toBe(first)
  hold = undefined
  release()
  await Promise.all(presses)

  expect(await zoom(ui)).toBe('8×')
  // The one in flight, then the latest: never one per press.
  expect(crops(runs).length - before).toBeLessThanOrEqual(2)
  expect(await imageFile(ui)).not.toBe(first)
})

test('has a close button and big arrows beside the thumbnails', async ($, on) => {
  world(on, { terminal: 'ghostty' })
  await twoPictures($)
  await runImage($, '2')
  const ui = await mountLightbox($)

  expect((await ui.find({ key: 'close-button' }))?.text).toMatch(/✕/)
  expect((await ui.find({ key: 'strip-previous' }))?.text).toMatch(/❮/)
  expect((await ui.find({ key: 'strip-next' }))?.text).toMatch(/❯/)
  await ui.press({ key: 'close-button' })
  expect(await header(ui)).toBeUndefined()
})

test('draws block symbols in the lightbox where the terminal draws no pictures', async ($, on) => {
  world(on)
  await pasted($, UUID)
  await runImage($, '1')
  const ui = await mountLightbox($)

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  // A Client laid over a Raster blanks it, so block symbols get no pad.
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
})

test('leaves the desktop app to draw images itself', async ($, on) => {
  world(on)
  await pasted($, UUID)

  const ui = await mountPrompt($, BLOCK_ID, PROMPT_ROW, 'desktop')

  expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
})

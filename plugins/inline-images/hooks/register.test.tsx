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
}
type Run = { argv: readonly string[]; stdin?: string }

const ok = (stdout = '') => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
const failed = { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }

const world = (
  on: On,
  { terminal = 'WarpTerminal', hasMagick = true, canDecode = true, history = [], env = {}, png = PNG }: World = {},
) => {
  const runs: Run[] = []
  const files = new Map<string, string>()
  mock.env(on, { TERM_PROGRAM: terminal, TMPDIR: `${TMP}/`, ...env })

  on('process.run', ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const [command] = e.argv
    if (command === 'magick') {
      if (!hasMagick) return { deny: 'magick: command not found' }
      return canDecode ? ok('2 2 2 2') : failed
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

test('/image <n> opens that picture full size in the image viewer', async ($, on) => {
  const runs = world(on)
  await pasted($, UUID)

  const answer = await runImage($, '1')

  const opened = runs.find(run => run.argv[0] === 'open')
  expect(opened?.argv.at(-1)).toMatch(/\.png$/)
  expect(JSON.stringify(answer)).toMatch(/image 1/)
})

test('/image lists the pictures of the conversation', async ($, on) => {
  world(on)
  await pasted($, UUID)

  const answer = await runImage($, '')

  expect(JSON.stringify(answer)).toMatch(/image 1 · 2×2/)
})

test('leaves the desktop app to draw images itself', async ($, on) => {
  world(on)
  await pasted($, UUID)

  const ui = await mountPrompt($, BLOCK_ID, PROMPT_ROW, 'desktop')

  expect(await ui.find({ type: 'Text', text: /engine row/ })).toBeDefined()
})

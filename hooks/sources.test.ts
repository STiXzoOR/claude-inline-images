import { describe, expect, test } from 'claude-code/testing'

import { drawsPictures, historyIndex, imagesOf, rowKey, sentImages } from './sources'

const png = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

describe('imagesOf', () => {
  test('keys a pasted image by the row it came in', () => {
    const content = [{ type: 'text', text: 'what is this [Image #1]' }, png('AAAA')]

    expect(imagesOf('row-1', content)).toEqual([{ key: 'row-1', mediaType: 'image/png', data: 'AAAA' }])
  })

  test('keys a tool result image by its tool_use_id', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'shot' }, png('BBBB')] }]

    expect(imagesOf('row-2', content)).toEqual([{ key: 'toolu_1', mediaType: 'image/png', data: 'BBBB' }])
  })

  test('skips images that are not inline base64', () => {
    expect(imagesOf('row-3', [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }])).toEqual([])
  })
})

describe('rowKey', () => {
  test('knows a row by its uuid less the last group, which the terminal swaps per block', () => {
    expect(rowKey('6c522156-904f-4532-9436-9889a1e9386d')).toBe(rowKey('6c522156-904f-4532-9436-000000000000'))
  })
})

describe('sentImages', () => {
  test('picks the image attachments of a SendUserFile result', () => {
    const result = {
      attachments: [
        { path: '/tmp/shot.png', size: 10, isImage: true, media_type: 'image/png' },
        { path: '/tmp/report.pdf', size: 10, isImage: false },
      ],
    }

    expect(sentImages(result)).toEqual(['/tmp/shot.png'])
  })

  test('answers nothing for a result without attachments', () => {
    expect(sentImages(undefined)).toEqual([])
    expect(sentImages({ text: 'nope' })).toEqual([])
  })
})

describe('historyIndex', () => {
  const messages = [
    { role: 'user' as const, content: [{ type: 'text', text: '[Image #1] what is this' }, png('PASTE'), { type: 'text', text: '<system-reminder>x</system-reminder>' }] },
    {
      role: 'assistant' as const,
      content: [
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/a.png' } },
        { type: 'tool_use', id: 'toolu_send', name: 'SendUserFile', input: { files: ['shots/b.jpg', '/abs/notes.md'] } },
      ],
    },
    {
      role: 'user' as const,
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_read', content: [png('READ')] },
        { type: 'tool_result', tool_use_id: 'toolu_send', content: 'sent' },
      ],
    },
  ]

  test('finds a pasted image by the prompt text drawn with it', () => {
    const index = historyIndex(messages, '/work')

    expect(index.get('prompt:[Image #1] what is this')).toEqual([{ mediaType: 'image/png', data: 'PASTE' }])
  })

  test('finds a tool result image by its tool_use_id', () => {
    expect(historyIndex(messages, '/work').get('toolu_read')).toEqual([{ mediaType: 'image/png', data: 'READ' }])
  })

  test('finds the image files a SendUserFile call sent, relative paths from the working directory', () => {
    expect(historyIndex(messages, '/work').get('toolu_send')).toEqual([{ path: '/work/shots/b.jpg' }])
  })
})

describe('drawsPictures', () => {
  test('is true in Ghostty and kitty', () => {
    expect(drawsPictures({ TERM_PROGRAM: 'ghostty' })).toBe(true)
    expect(drawsPictures({ TERM: 'xterm-kitty' })).toBe(true)
    expect(drawsPictures({ KITTY_WINDOW_ID: '1' })).toBe(true)
  })

  test('is false in Warp, iTerm2 and Terminal.app', () => {
    expect(drawsPictures({ TERM_PROGRAM: 'WarpTerminal' })).toBe(false)
    expect(drawsPictures({ TERM_PROGRAM: 'iTerm.app' })).toBe(false)
    expect(drawsPictures({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false)
  })

  test('is false inside tmux or screen, even in Ghostty', () => {
    expect(drawsPictures({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1/default,1,0' })).toBe(false)
    expect(drawsPictures({ GHOSTTY_RESOURCES_DIR: '/x', STY: '1.pts' })).toBe(false)
  })

  test('is true wherever Claude Code is told to force terminal images', () => {
    expect(drawsPictures({ TERM_PROGRAM: 'WarpTerminal', CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1' })).toBe(true)
  })
})

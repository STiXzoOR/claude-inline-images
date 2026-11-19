/** One inline image found in a row: the key it is drawn under, and its base64 bytes. */
export type Found = { key: string; mediaType: string; data: string }

/** Where a picture comes from: inline base64 bytes, or a file on disk. */
export type Source = { mediaType: string; data: string } | { path: string }

type ApiMessage = { role: 'user' | 'assistant'; content: readonly unknown[] }
type Block = { type?: unknown; source?: unknown; tool_use_id?: unknown; content?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown }
type ImageSource = { type?: unknown; media_type?: unknown; data?: unknown }

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif)$/i

const inline = (block: Block): Source | undefined => {
  if (block.type !== 'image') return undefined
  const source = (block.source ?? {}) as ImageSource
  if (source.type !== 'base64' || typeof source.data !== 'string') return undefined

  return { mediaType: String(source.media_type ?? 'image/png'), data: source.data }
}

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? content.map(raw => (raw ?? {}) as Block) : [])

/**
 * The images a conversation row carries: a pasted one keyed by `key` (the
 * row's), a tool result's keyed by the tool_use_id its row is drawn under.
 */
export const imagesOf = (key: string, content: readonly unknown[]): Found[] => {
  const found: Found[] = []
  for (const block of blocksOf(content)) {
    const own = inline(block)
    if (own && 'data' in own) found.push({ key, ...own })
    if (block.type === 'tool_result') {
      for (const inner of blocksOf(block.content)) {
        const image = inline(inner)
        if (image && 'data' in image) found.push({ key: String(block.tool_use_id), ...image })
      }
    }
  }
  return found
}

/**
 * A transcript row's key: its uuid less the last group, which the terminal
 * replaces with the block's index when it draws a row block by block.
 */
export const rowKey = (id: string) => id.slice(0, 23)

/** The image files a SendUserFile result says it sent. */
export const sentImages = (result: unknown): string[] => {
  const attachments = (result as { attachments?: unknown } | undefined)?.attachments
  if (!Array.isArray(attachments)) return []
  return attachments.flatMap(raw => {
    const attachment = (raw ?? {}) as { path?: unknown; isImage?: unknown }
    return attachment.isImage === true && typeof attachment.path === 'string' ? [attachment.path] : []
  })
}

const absolute = (path: string, cwd: string) => (path.startsWith('/') ? path : `${cwd.replace(/\/+$/, '')}/${path}`)

/**
 * Every image a loaded conversation holds, keyed as its transcript row is
 * drawn: a pasted image by `prompt:<the text beside it>`, a tool result's by
 * its tool_use_id, and the files a SendUserFile call sent by that call's id.
 */
export const historyIndex = (messages: readonly ApiMessage[], cwd: string) => {
  const index = new Map<string, Source[]>()
  const add = (key: string, sources: Source[]) => {
    if (sources.length > 0) index.set(key, [...(index.get(key) ?? []), ...sources])
  }

  for (const message of messages) {
    const blocks = blocksOf(message.content)
    if (message.role === 'user') {
      const pasted = blocks.flatMap(block => inline(block) ?? [])
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') add(`prompt:${block.text.trim()}`, pasted)
        if (block.type === 'tool_result') {
          add(String(block.tool_use_id), blocksOf(block.content).flatMap(inner => inline(inner) ?? []))
        }
      }
    } else {
      for (const block of blocks) {
        if (block.type !== 'tool_use' || block.name !== 'SendUserFile') continue
        const files = (block.input as { files?: unknown } | undefined)?.files
        const paths = Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : []
        add(String(block.id), paths.filter(path => IMAGE_FILE.test(path)).map(path => ({ path: absolute(path, cwd) })))
      }
    }
  }

  return index
}

/**
 * Whether Claude Code draws its `Image` element as real pixels here. It does
 * not tell mods, so this mirrors its rule as the environment shows it:
 * always when CLAUDE_CODE_FORCE_TERMINAL_IMAGES is set; never inside tmux,
 * screen or a background session; otherwise only in kitty and Ghostty.
 * (The same rule jarrodwatts/claude-image-view reads, MIT.)
 */
export const drawsPictures = (env: Readonly<Record<string, string | undefined>>) => {
  if (env.CLAUDE_CODE_FORCE_TERMINAL_IMAGES) return true
  if (env.TMUX || env.STY || env.CLAUDE_CODE_SESSION_KIND === 'bg') return false
  return (
    Boolean(env.KITTY_WINDOW_ID || env.GHOSTTY_RESOURCES_DIR) ||
    /kitty|ghostty/i.test(env.TERM ?? '') ||
    /^ghostty$/i.test(env.TERM_PROGRAM ?? '')
  )
}

import type { ClientModule } from 'claude-code'

/**
 * What the pad laid over the lightbox's picture hands the hooks module: a key
 * pressed while it holds the focus (a click gives it), or a drag, as shares of
 * the pad's width and height, signed the way the view moves.
 */
export type PadMessage =
  | { type: 'key'; key: string }
  | { type: 'drag'; gesture: number; dx: number; dy: number; done: boolean }

type Props = { columns: number; rows: number }
type Point = { x: number; y: number }

/** Draws nothing: a transparent region over the picture that listens. */
const Pad: ClientModule<Props, true> = (props, surface) => {
  if (surface.state === undefined) {
    let from: Point | undefined
    let gesture = 0
    // The sub-cell position where the terminal reports one, else the cell's middle.
    const at = (e: { x: number; y: number; fine?: Point }): Point => ({ x: e.fine?.x ?? e.x + 0.5, y: e.fine?.y ?? e.y + 0.5 })
    const post = (message: PadMessage) => surface.post(message)

    surface.onKey(e => post({ type: 'key', key: e.key }))
    surface.onPointer(e => {
      if (e.type === 'down' && e.button === 'left') {
        from = at(e)
        gesture++
        return
      }
      if (from === undefined || (e.type !== 'move' && e.type !== 'up')) return
      const now = at(e)
      // Each post carries the whole drag so far: a later one replaces one undelivered.
      post({
        type: 'drag',
        gesture,
        dx: -(now.x - from.x) / Math.max(1, surface.columns),
        dy: -(now.y - from.y) / Math.max(1, surface.rows),
        done: e.type === 'up',
      })
      if (e.type === 'up') from = undefined
    })
    surface.setState(true)
  }
  const { Box } = surface.elements
  return Box({ width: props.columns, height: props.rows })
}

export default Pad

import type { ClientModule } from 'claude-code'

/** What a click on a lightbox thumbnail hands the hooks module. */
export type TapMessage = { type: 'tap'; n: number }

type Props = { n: number; columns: number; rows: number }

/**
 * Draws nothing: a transparent region over a thumbnail. A click (a press and
 * release with little movement between) opens that picture.
 */
const Tap: ClientModule<Props, true> = (props, surface) => {
  if (surface.state === undefined) {
    let from: { x: number; y: number } | undefined
    surface.onPointer(e => {
      if (e.type === 'down' && e.button === 'left') from = { x: e.x, y: e.y }
      if (e.type !== 'up' || from === undefined) return
      const moved = Math.abs(e.x - from.x) + Math.abs(e.y - from.y)
      from = undefined
      if (moved <= 1) surface.post({ type: 'tap', n: props.n } satisfies TapMessage)
    })
    surface.setState(true)
  }
  const { Box } = surface.elements
  return Box({ width: props.columns, height: props.rows })
}

export default Tap

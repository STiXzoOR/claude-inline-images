/**
 * The lightbox's view of one picture: how far it is zoomed, and which point of
 * the picture sits in the middle of the window, as fractions of its width and
 * height (0.5, 0.5 is the centre). At zoom 1 the window is the whole picture.
 */
export type View = { zoom: number; cx: number; cy: number }

/** A point in the window, as fractions of its width and height. */
export type At = { x: number; y: number }

export const MAX_ZOOM = 8

export const fitView = (): View => ({ zoom: 1, cx: 0.5, cy: 0.5 })

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/** The view moved back inside the picture: no window past its edges. */
function settle(view: View): View {
  const zoom = clamp(view.zoom, 1, MAX_ZOOM)
  const half = 0.5 / zoom
  return { zoom, cx: clamp(view.cx, half, 1 - half), cy: clamp(view.cy, half, 1 - half) }
}

/** Zooms by `factor`, keeping the picture's point under `at` where it is. */
export function zoomAt(view: View, factor: number, at: At = { x: 0.5, y: 0.5 }): View {
  const zoom = clamp(view.zoom * factor, 1, MAX_ZOOM)
  const px = view.cx + (at.x - 0.5) / view.zoom
  const py = view.cy + (at.y - 0.5) / view.zoom
  return settle({ zoom, cx: px - (at.x - 0.5) / zoom, cy: py - (at.y - 0.5) / zoom })
}

/** Moves the window by `dx`, `dy` of its own width and height. */
export const panBy = (view: View, dx: number, dy: number): View =>
  settle({ zoom: view.zoom, cx: view.cx + dx / view.zoom, cy: view.cy + dy / view.zoom })

/** The part of a `width` x `height` picture the view shows, in whole pixels. */
export function cropRect(view: View, width: number, height: number) {
  const w = Math.max(1, Math.min(width, Math.round(width / view.zoom)))
  const h = Math.max(1, Math.min(height, Math.round(height / view.zoom)))
  const x = clamp(Math.round(view.cx * width - w / 2), 0, width - w)
  const y = clamp(Math.round(view.cy * height - h / 2), 0, height - h)
  return { x, y, width: w, height: h }
}

/** The picture number after (`1`) or before (`-1`) `current`, wrapping round. */
export function step(numbers: readonly number[], current: number, direction: 1 | -1): number {
  const sorted = [...numbers].sort((a, b) => a - b)
  if (sorted.length === 0) return current
  if (direction === 1) return sorted.find(n => n > current) ?? sorted[0]!
  return [...sorted].reverse().find(n => n < current) ?? sorted.at(-1)!
}

/** Where the picture sits in its pane: the body row and column it starts at, and its size in cells. */
export type Stage = { top: number; left: number; columns: number; rows: number }

/** The share of the picture under a pane body cell (the cell's middle), kept on the picture. */
export const pointerAt = (cell: { column: number; row: number }, stage: Stage): At => ({
  x: clamp((cell.column - stage.left + 0.5) / Math.max(1, stage.columns), 0, 1),
  y: clamp((cell.row - stage.top + 0.5) / Math.max(1, stage.rows), 0, 1),
})

/**
 * How many times to enlarge a crop `width` pixels wide, by nearest neighbour,
 * before the terminal draws it `columns` wide: enough that its pixels show as
 * sharp squares, not the terminal's blur. A cell is taken as 20 pixels (a
 * Retina screen's), and the result is never wider than 2000 pixels.
 */
export function crispFactor(width: number, columns: number): number {
  const wanted = Math.ceil((columns * 20) / Math.max(1, width))
  const most = Math.floor(2000 / Math.max(1, width))
  const factor = Math.min(wanted, most)
  return factor >= 2 ? factor : 1
}

/** The navigator's box: the part of the picture the view shows, in an overview `width` x `height` pixels. */
export function navigatorBox(view: View, width: number, height: number) {
  const half = 0.5 / view.zoom
  return {
    x0: Math.round((view.cx - half) * width),
    y0: Math.round((view.cy - half) * height),
    x1: Math.round((view.cx + half) * width) - 1,
    y1: Math.round((view.cy + half) * height) - 1,
  }
}

/** The `count` picture numbers the strip shows, the open one kept as near the middle as the ends allow. */
export function thumbWindow(numbers: readonly number[], current: number, count: number): number[] {
  const sorted = [...numbers].sort((a, b) => a - b)
  if (sorted.length <= count) return sorted
  const at = Math.max(0, sorted.indexOf(current))
  const from = Math.max(0, Math.min(at - Math.floor(count / 2), sorted.length - count))
  return sorted.slice(from, from + count)
}

/** A decoded picture: `width * height` RGBA pixels, 4 bytes each. */
export type Pixels = { width: number; height: number; rgba: Uint8Array }

/**
 * How a cell is cut: `halves` is one upper-half block per cell (two pixels
 * tall), `symbols` picks among the block elements on a 4x8 grid per cell.
 */
export type Style = 'symbols' | 'halves'

type Glyph = { code: number; mask: number }
type Table = { columns: number; rows: number; glyphs: Glyph[] }

const SPACE = 0x20
const TERMINAL_DEFAULT = 0x01000000
// The cost of drawing a clear sub-pixel in a colour, or a coloured one as the
// terminal's own background: a quarter of the largest squared error (3).
const CLEAR_COST = 0.75

const maskOf = (columns: number, rows: number, isOn: (x: number, y: number) => boolean) => {
  let mask = 0
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) if (isOn(x, y)) mask |= 1 << (y * columns + x)
  }
  return mask >>> 0
}

const table = (columns: number, rows: number, glyphs: [number, (x: number, y: number) => boolean][]): Table => ({
  columns,
  rows,
  glyphs: glyphs.map(([code, isOn]) => ({ code, mask: maskOf(columns, rows, isOn) })),
})

// Earlier glyphs win ties, so a picture both of a pair draw equally well gets
// the first: the upper half before the lower, a corner before its complement.
const TABLES: Record<Style, Table> = {
  halves: table(1, 2, [
    [0x2580, (x, y) => y === 0],
    [0x2584, (x, y) => y === 1],
  ]),
  symbols: table(4, 8, [
    [0x2580, (x, y) => y < 4],
    [0x2584, (x, y) => y >= 4],
    [0x258c, x => x < 2],
    [0x2590, x => x >= 2],
    [0x2598, (x, y) => x < 2 && y < 4],
    [0x259d, (x, y) => x >= 2 && y < 4],
    [0x2596, (x, y) => x < 2 && y >= 4],
    [0x2597, (x, y) => x >= 2 && y >= 4],
    [0x259a, (x, y) => x < 2 === y < 4],
    [0x259e, (x, y) => x < 2 !== y < 4],
    [0x2599, (x, y) => !(x >= 2 && y < 4)],
    [0x259b, (x, y) => !(x >= 2 && y >= 4)],
    [0x259c, (x, y) => !(x < 2 && y >= 4)],
    [0x259f, (x, y) => !(x < 2 && y < 4)],
    [0x2581, (x, y) => y >= 7],
    [0x2582, (x, y) => y >= 6],
    [0x2583, (x, y) => y >= 5],
    [0x2585, (x, y) => y >= 3],
    [0x2586, (x, y) => y >= 2],
    [0x2587, (x, y) => y >= 1],
    [0x2594, (x, y) => y < 1],
    [0x258e, x => x < 1],
    [0x258a, x => x < 3],
  ]),
}

const TO_LINEAR = Float64Array.from({ length: 256 }, (_, byte) => {
  const c = byte / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

const toSrgb = (linear: number) => {
  const c = Math.min(1, Math.max(0, linear))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

const toByte = (srgb: number) => Math.round(Math.min(1, Math.max(0, srgb)) * 255)

const span = (index: number, size: number, parts: number): [number, number] => {
  const start = Math.min(Math.floor((index * size) / parts), size - 1)
  const end = Math.max(start + 1, Math.min(size, Math.floor(((index + 1) * size) / parts)))
  return [start, end]
}

/**
 * Box-averages the picture into a width x height grid: in linear light, so a
 * sub-pixel half black and half white is the grey it looks from afar, then
 * gamma-encoded, so fitting a cell's two colours weighs differences as the eye
 * does and a thin bright edge does not tint the dark field beside it.
 */
const sample = ({ width, height, rgba }: Pixels, gridWidth: number, gridHeight: number) => {
  const color = new Float64Array(gridWidth * gridHeight * 3)
  const isClear = new Uint8Array(gridWidth * gridHeight)

  for (let gy = 0; gy < gridHeight; gy++) {
    const [y0, y1] = span(gy, height, gridHeight)
    for (let gx = 0; gx < gridWidth; gx++) {
      const [x0, x1] = span(gx, width, gridWidth)
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = (y * width + x) * 4
          const a = rgba[at + 3]! / 255
          r += TO_LINEAR[rgba[at]!]! * a
          g += TO_LINEAR[rgba[at + 1]!]! * a
          b += TO_LINEAR[rgba[at + 2]!]! * a
          alpha += a
        }
      }
      const cell = gy * gridWidth + gx
      const isMostlyClear = alpha / ((x1 - x0) * (y1 - y0)) < 0.5
      isClear[cell] = isMostlyClear ? 1 : 0
      if (!isMostlyClear) {
        color[cell * 3] = toSrgb(r / alpha)
        color[cell * 3 + 1] = toSrgb(g / alpha)
        color[cell * 3 + 2] = toSrgb(b / alpha)
      }
    }
  }

  return { color, isClear }
}

type Side = { opaque: number; clear: number; r: number; g: number; b: number; squares: number }
type Pick = { cost: number; color: number }

const emptySide = (): Side => ({ opaque: 0, clear: 0, r: 0, g: 0, b: 0, squares: 0 })

/** The cheapest colour for one side of a glyph: its mean, or (as background) the terminal's own. */
const pick = (side: Side, mayBeDefault: boolean): Pick => {
  const asDefault = side.opaque * CLEAR_COST
  if (side.opaque === 0) {
    return mayBeDefault ? { cost: 0, color: TERMINAL_DEFAULT } : { cost: side.clear * CLEAR_COST, color: 0 }
  }
  const spread = side.squares - (side.r * side.r + side.g * side.g + side.b * side.b) / side.opaque
  const asColor = Math.max(0, spread) + side.clear * CLEAR_COST
  if (mayBeDefault && asDefault < asColor) return { cost: asDefault, color: TERMINAL_DEFAULT }

  const mean = (sum: number) => toByte(sum / side.opaque)
  return { cost: asColor, color: (mean(side.r) << 16) | (mean(side.g) << 8) | mean(side.b) }
}

/**
 * Packs a picture into a Raster's cells, `columns` x `rows` of them, base64:
 * per cell the glyph and the two colours that come closest to its pixels.
 */
export const renderCells = (pixels: Pixels, columns: number, rows: number, style: Style): string => {
  const { columns: subColumns, rows: subRows, glyphs } = TABLES[style]
  const gridWidth = columns * subColumns
  const { color, isClear } = sample(pixels, gridWidth, rows * subRows)
  const count = subColumns * subRows
  const words = new DataView(new ArrayBuffer(columns * rows * 12))

  const side = emptySide()
  const other = emptySide()
  const add = (into: Side, at: number) => {
    if (isClear[at]) {
      into.clear++
      return
    }
    const r = color[at * 3]!
    const g = color[at * 3 + 1]!
    const b = color[at * 3 + 2]!
    into.opaque++
    into.r += r
    into.g += g
    into.b += b
    into.squares += r * r + g * g + b * b
  }
  const reset = (into: Side) => {
    into.opaque = into.clear = into.r = into.g = into.b = into.squares = 0
  }

  const subPixels = new Int32Array(count)
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      for (let i = 0; i < count; i++) {
        const x = column * subColumns + (i % subColumns)
        const y = row * subRows + Math.floor(i / subColumns)
        subPixels[i] = y * gridWidth + x
      }

      reset(side)
      for (let i = 0; i < count; i++) add(side, subPixels[i]!)
      const flat = pick(side, true)
      let best = { cost: flat.cost, code: SPACE, fg: flat.color, bg: flat.color }

      for (const glyph of glyphs) {
        reset(side)
        reset(other)
        for (let i = 0; i < count; i++) add((glyph.mask >>> i) & 1 ? side : other, subPixels[i]!)
        const fg = pick(side, false)
        const bg = pick(other, true)
        const cost = fg.cost + bg.cost
        if (cost < best.cost - 1e-9) best = { cost, code: glyph.code, fg: fg.color, bg: bg.color }
      }

      const at = (row * columns + column) * 12
      words.setUint32(at, best.code, true)
      words.setUint32(at + 4, best.fg, true)
      words.setUint32(at + 8, best.bg, true)
    }
  }

  return new Uint8Array(words.buffer).toBase64()
}

/**
 * The cell box a width x height picture fills at most maxColumns by maxRows,
 * a cell being about twice as tall as it is wide.
 */
export const fitCells = (width: number, height: number, maxColumns: number, maxRows: number) => {
  let columns = maxColumns
  let rows = Math.round((columns * height) / width / 2)

  if (rows > maxRows) {
    rows = maxRows
    columns = Math.min(maxColumns, Math.round((rows * 2 * width) / height))
  }

  return { columns: Math.max(1, columns), rows: Math.max(1, rows) }
}

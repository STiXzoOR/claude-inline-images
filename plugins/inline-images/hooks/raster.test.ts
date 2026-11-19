import { expect, test } from 'claude-code/testing'

import { fitCells, renderCells } from './raster'

const DEFAULT = 0x01000000
const RED = [0xff, 0, 0, 0xff]
const BLUE = [0, 0, 0xff, 0xff]
const GREEN = [0, 0xff, 0, 0xff]
const CLEAR = [0xff, 0xff, 0xff, 0]

/** The Raster cells as [codePoint, foreground, background] triplets. */
const cellsOf = (base64: string) => {
  const bytes = Uint8Array.fromBase64(base64)
  const view = new DataView(bytes.buffer)
  const words: number[] = []
  for (let at = 0; at < bytes.length; at += 4) words.push(view.getUint32(at, true))
  return words
}

/** A width x height picture painted pixel by pixel. */
const picture = (width: number, height: number, paint: (x: number, y: number) => number[]) => {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rgba.set(paint(x, y), (y * width + x) * 4)
  }
  return { width, height, rgba }
}

test('halves paint the top pixel as foreground and the bottom as background', () => {
  const cells = renderCells(picture(1, 2, (x, y) => (y === 0 ? RED : BLUE)), 1, 1, 'halves')

  expect(cellsOf(cells)).toEqual([0x2580, 0xff0000, 0x0000ff])
})

test('halves keep a clear half as the terminal background, never its foreground', () => {
  const cells = renderCells(picture(1, 2, (x, y) => (y === 0 ? CLEAR : GREEN)), 1, 1, 'halves')

  expect(cellsOf(cells)).toEqual([0x2584, 0x00ff00, DEFAULT])
})

test('a clear cell is left to the terminal', () => {
  const cells = renderCells(picture(1, 2, () => CLEAR), 1, 1, 'halves')

  expect(cellsOf(cells)).toEqual([0x20, DEFAULT, DEFAULT])
})

test('averages in linear light, so black beside white is a light grey', () => {
  const black = [0, 0, 0, 0xff]
  const white = [0xff, 0xff, 0xff, 0xff]
  const cells = renderCells(picture(2, 2, (x, y) => (y === 0 && x === 0 ? black : white)), 1, 1, 'halves')

  expect(cellsOf(cells)).toEqual([0x2580, 0xbcbcbc, 0xffffff])
})

test('symbols split a cell down the middle with a half block', () => {
  const cells = renderCells(picture(4, 8, x => (x < 2 ? RED : BLUE)), 1, 1, 'symbols')

  expect(cellsOf(cells)).toEqual([0x258c, 0xff0000, 0x0000ff])
})

test('symbols draw a lone corner as a quadrant', () => {
  const cells = renderCells(picture(4, 8, (x, y) => (x < 2 && y < 4 ? RED : BLUE)), 1, 1, 'symbols')

  expect(cellsOf(cells)).toEqual([0x2598, 0xff0000, 0x0000ff])
})

test('symbols draw a diagonal pair of corners as one glyph', () => {
  const cells = renderCells(picture(4, 8, (x, y) => ((x < 2) === (y < 4) ? RED : BLUE)), 1, 1, 'symbols')

  expect(cellsOf(cells)).toEqual([0x259a, 0xff0000, 0x0000ff])
})

test('symbols draw a thin bottom edge as a lower eighth', () => {
  const cells = renderCells(picture(4, 8, (x, y) => (y === 7 ? RED : BLUE)), 1, 1, 'symbols')

  expect(cellsOf(cells)).toEqual([0x2581, 0xff0000, 0x0000ff])
})

test('symbols paint a flat cell as a coloured space', () => {
  const cells = renderCells(picture(4, 8, () => GREEN), 1, 1, 'symbols')

  expect(cellsOf(cells)).toEqual([0x20, 0x00ff00, 0x00ff00])
})

test('symbols keep a clear top half as the terminal background', () => {
  const cells = renderCells(picture(4, 8, (x, y) => (y < 4 ? CLEAR : GREEN)), 1, 1, 'symbols')

  expect(cellsOf(cells)).toEqual([0x2584, 0x00ff00, DEFAULT])
})

test('symbols keep a dark field its own colour where a bright edge partly covers a sub-pixel', () => {
  // A 4x24 cell of dark with a pink edge: pixel row 20 starts the pink, so
  // sub-pixel row 6 is a third pink and row 7 all pink.
  const dark = [0x1e, 0x1e, 0x2e, 0xff]
  const pink = [0xf3, 0x8b, 0xa8, 0xff]
  const cells = renderCells(picture(4, 24, (x, y) => (y >= 20 ? pink : dark)), 1, 1, 'symbols')

  const [code, , background] = cellsOf(cells)
  expect(code).toBe(0x2582)
  expect(background).toBe(0x1e1e2e)
})

test('symbols sample a larger picture down to the cell', () => {
  // 8x16 into one cell: each of the 4x8 sub-pixels averages a 2x2 block.
  const cells = renderCells(picture(8, 16, x => (x < 4 ? RED : BLUE)), 1, 1, 'symbols')

  expect(cellsOf(cells)).toEqual([0x258c, 0xff0000, 0x0000ff])
})

test('renders every cell of a wider box, row by row', () => {
  const cells = renderCells(picture(2, 2, x => (x === 0 ? RED : BLUE)), 2, 1, 'halves')

  expect(cellsOf(cells)).toEqual([0x20, 0xff0000, 0xff0000, 0x20, 0x0000ff, 0x0000ff])
})

test('fitCells keeps a wide picture at full width, half as many rows', () => {
  expect(fitCells(200, 100, 60, 20)).toEqual({ columns: 60, rows: 15 })
})

test('fitCells shrinks a tall picture to the row limit and narrows it to match', () => {
  expect(fitCells(100, 400, 60, 20)).toEqual({ columns: 10, rows: 20 })
})

test('fitCells never answers less than one cell', () => {
  expect(fitCells(1000, 1, 60, 20)).toEqual({ columns: 60, rows: 1 })
})

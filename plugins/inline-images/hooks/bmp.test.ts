import { expect, test } from 'claude-code/testing'

import { decodeBmp } from './bmp'

type Layout = { width: number; height: number; bpp: 24 | 32; compression: 0 | 3; pixels: number[] }

/** A BMP file: BITMAPINFOHEADER, or BITMAPV4HEADER with masks for BI_BITFIELDS. */
const bmp = ({ width, height, bpp, compression, pixels }: Layout) => {
  const headerSize = compression === 3 ? 108 : 40
  const offset = 14 + headerSize
  const bytes = new Uint8Array(offset + pixels.length)
  const view = new DataView(bytes.buffer)
  bytes[0] = 0x42
  bytes[1] = 0x4d
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, offset, true)
  view.setUint32(14, headerSize, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, bpp, true)
  view.setUint32(30, compression, true)
  if (compression === 3) {
    view.setUint32(54, 0x00ff0000, true)
    view.setUint32(58, 0x0000ff00, true)
    view.setUint32(62, 0x000000ff, true)
    view.setUint32(66, 0xff000000, true)
  }
  bytes.set(pixels, offset)
  return bytes
}

test('decodes a top-down 32-bit BMP with channel masks, alpha included', () => {
  // Two pixels, BGRA in memory: opaque red, half-clear green.
  const file = bmp({ width: 2, height: -1, bpp: 32, compression: 3, pixels: [0, 0, 0xff, 0xff, 0, 0xff, 0, 0x80] })

  expect(decodeBmp(file)).toEqual({
    width: 2,
    height: 1,
    rgba: Uint8Array.from([0xff, 0, 0, 0xff, 0, 0xff, 0, 0x80]),
  })
})

test('decodes a bottom-up 24-bit BMP, skipping each row to its 4-byte padding', () => {
  // 1x2 stored bottom row first: blue (then a pad byte), then red.
  const file = bmp({ width: 1, height: 2, bpp: 24, compression: 0, pixels: [0xff, 0, 0, 0, 0, 0, 0xff, 0] })

  expect(decodeBmp(file)).toEqual({
    width: 1,
    height: 2,
    rgba: Uint8Array.from([0xff, 0, 0, 0xff, 0, 0, 0xff, 0xff]),
  })
})

test('reads a 32-bit BMP with no alpha written as opaque', () => {
  const file = bmp({ width: 1, height: 1, bpp: 32, compression: 0, pixels: [0x10, 0x20, 0x30, 0] })

  expect(decodeBmp(file)?.rgba).toEqual(Uint8Array.from([0x30, 0x20, 0x10, 0xff]))
})

test('answers null for bytes that are not a BMP', () => {
  expect(decodeBmp(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
})

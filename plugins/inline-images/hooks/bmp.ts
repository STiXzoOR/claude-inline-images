import type { Pixels } from './raster'

const BI_RGB = 0
const BI_BITFIELDS = 3

/** Reads one channel through its mask, scaled to 0..255. */
const channel = (value: number, mask: number) => {
  if (mask === 0) return 0
  const shift = 31 - Math.clz32(mask & -mask)
  const max = mask >>> shift
  return Math.round((((value & mask) >>> shift) * 255) / max)
}

/**
 * Decodes an uncompressed 24- or 32-bit BMP, as macOS `sips -s format bmp`
 * writes it, into RGBA; null for anything else.
 */
export const decodeBmp = (bytes: Uint8Array): Pixels | null => {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const offset = view.getUint32(10, true)
  const headerSize = view.getUint32(14, true)
  const width = view.getInt32(18, true)
  const storedHeight = view.getInt32(22, true)
  const bpp = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  const height = Math.abs(storedHeight)
  const isTopDown = storedHeight < 0

  if (width <= 0 || height === 0 || (bpp !== 24 && bpp !== 32)) return null
  if (compression !== BI_RGB && compression !== BI_BITFIELDS) return null

  let masks = { r: 0x00ff0000, g: 0x0000ff00, b: 0x000000ff, a: bpp === 32 ? 0xff000000 : 0 }
  if (compression === BI_BITFIELDS) {
    const at = headerSize >= 52 ? 54 : 14 + headerSize
    masks = {
      r: view.getUint32(at, true),
      g: view.getUint32(at + 4, true),
      b: view.getUint32(at + 8, true),
      a: headerSize >= 56 ? view.getUint32(at + 12, true) : 0,
    }
  }

  const stride = Math.ceil((width * bpp) / 32) * 4
  if (offset + stride * height > bytes.length) return null

  const rgba = new Uint8Array(width * height * 4)
  let hasAlpha = false
  for (let y = 0; y < height; y++) {
    const row = offset + (isTopDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const at = row + x * (bpp / 8)
      const value = bpp === 32 ? view.getUint32(at, true) : bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
      const out = (y * width + x) * 4
      rgba[out] = channel(value, masks.r)
      rgba[out + 1] = channel(value, masks.g)
      rgba[out + 2] = channel(value, masks.b)
      rgba[out + 3] = masks.a ? channel(value, masks.a) : 0xff
      if (rgba[out + 3] !== 0) hasAlpha = true
    }
  }

  // A 32-bit BMP whose alpha is zero throughout never wrote one: it is opaque.
  if (!hasAlpha) for (let at = 3; at < rgba.length; at += 4) rgba[at] = 0xff

  return { width, height, rgba }
}

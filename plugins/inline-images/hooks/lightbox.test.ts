import { describe, expect, test } from 'claude-code/testing'

import { MAX_ZOOM, crispFactor, cropRect, fitView, navigatorBox, panBy, pointerAt, step, thumbWindow, zoomAt } from './lightbox'

// The test kit has no toBeCloseTo.
const near = (value: number) => Math.round(value * 1e6) / 1e6

describe('zoomAt', () => {
  test('zooms about the middle when no point is given', () => {
    expect(zoomAt(fitView(), 2)).toEqual({ zoom: 2, cx: 0.5, cy: 0.5 })
  })

  test('keeps the point under the pointer where it was', () => {
    // At fit, the point a quarter across the window is a quarter across the picture.
    const view = zoomAt(fitView(), 2, { x: 0.25, y: 0.25 })
    // Zoomed 2x, the window is half the picture, and that point must still
    // sit a quarter across it: the window's left edge is at 0.125.
    expect(view.zoom).toBe(2)
    expect(near(view.cx - 0.5 / view.zoom + 0.25 / view.zoom)).toBe(0.25)
    expect(near(view.cy - 0.5 / view.zoom + 0.25 / view.zoom)).toBe(0.25)
  })

  test('never zooms out past fit or in past the most', () => {
    expect(zoomAt(fitView(), 0.5)).toEqual(fitView())
    expect(zoomAt(fitView(), 100).zoom).toBe(MAX_ZOOM)
  })

  test('zooming back out to fit centres the picture again', () => {
    const view = zoomAt(zoomAt(fitView(), 4, { x: 0.9, y: 0.1 }), 0.25)
    expect(view).toEqual(fitView())
  })
})

describe('panBy', () => {
  test('moves by a share of the window, so a drag tracks the pointer at any zoom', () => {
    const view = panBy({ zoom: 4, cx: 0.5, cy: 0.5 }, 0.5, 0)
    // Half a window at 4x is an eighth of the picture.
    expect(near(view.cx)).toBe(0.625)
    expect(view.cy).toBe(0.5)
  })

  test('stops at the picture edge', () => {
    expect(panBy({ zoom: 2, cx: 0.5, cy: 0.5 }, -10, 10)).toEqual({ zoom: 2, cx: 0.25, cy: 0.75 })
  })

  test('does nothing at fit', () => {
    expect(panBy(fitView(), 1, 1)).toEqual(fitView())
  })
})

describe('cropRect', () => {
  test('is the whole picture at fit', () => {
    expect(cropRect(fitView(), 1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })

  test('is the window the view shows, in whole pixels', () => {
    expect(cropRect({ zoom: 2, cx: 0.75, cy: 0.25 }, 1920, 1080)).toEqual({ x: 960, y: 0, width: 960, height: 540 })
  })

  test('is never smaller than one pixel', () => {
    expect(cropRect({ zoom: MAX_ZOOM, cx: 0.5, cy: 0.5 }, 3, 3)).toMatchObject({ width: 1, height: 1 })
  })
})

describe('step', () => {
  test('goes to the next and previous picture by number', () => {
    expect(step([1, 2, 3], 2, 1)).toBe(3)
    expect(step([1, 2, 3], 2, -1)).toBe(1)
  })

  test('wraps around at either end', () => {
    expect(step([1, 2, 3], 3, 1)).toBe(1)
    expect(step([1, 2, 3], 1, -1)).toBe(3)
  })

  test('starts from the nearest picture when the current one is gone', () => {
    expect(step([1, 4, 7], 5, 1)).toBe(7)
    expect(step([1, 4, 7], 5, -1)).toBe(4)
  })
})

describe('pointerAt', () => {
  const stage = { top: 1, left: 5, columns: 40, rows: 20 }

  test('is the share of the picture under a pane cell, past the header row and the centring margin', () => {
    expect(pointerAt({ column: 5 + 9.5, row: 1 + 4.5 }, stage)).toEqual({ x: 0.25, y: 0.25 })
  })

  test('stays on the picture when the pointer is over the header or the toolbar', () => {
    expect(pointerAt({ column: -3, row: 0 }, stage)).toEqual({ x: 0, y: 0 })
    expect(pointerAt({ column: 99, row: 30 }, stage)).toEqual({ x: 1, y: 1 })
  })
})

describe('crispFactor', () => {
  test('enlarges a crop smaller than the room it fills by whole steps, so its pixels stay sharp', () => {
    // 40 columns are about 800 pixels on a Retina screen: a 50-pixel crop goes up 16 times.
    expect(crispFactor(50, 40)).toBe(16)
  })

  test('leaves a crop alone that already has the pixels', () => {
    expect(crispFactor(1000, 40)).toBe(1)
  })

  test('never makes a crop wider than 2000 pixels', () => {
    expect(crispFactor(300, 200)).toBe(6)
  })
})

describe('navigatorBox', () => {
  test('marks the part of the picture the view shows, in the overview\'s pixels', () => {
    expect(navigatorBox({ zoom: 2, cx: 0.75, cy: 0.25 }, 100, 80)).toEqual({ x0: 50, y0: 0, x1: 99, y1: 39 })
  })
})

describe('thumbWindow', () => {
  test('shows every picture when they fit', () => {
    expect(thumbWindow([1, 2, 3], 2, 5)).toEqual([1, 2, 3])
  })

  test('keeps the open picture in the middle of a window that slides', () => {
    expect(thumbWindow([1, 2, 3, 4, 5, 6, 7], 5, 3)).toEqual([4, 5, 6])
    expect(thumbWindow([1, 2, 3, 4, 5, 6, 7], 1, 3)).toEqual([1, 2, 3])
    expect(thumbWindow([1, 2, 3, 4, 5, 6, 7], 7, 3)).toEqual([5, 6, 7])
  })
})

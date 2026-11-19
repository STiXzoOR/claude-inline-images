# Changelog

## 0.3.0 (2026-11-19)

- A lightbox. `/image N`, `/image` for the latest, or a click on a picture's caption opens it in a pane: step through the conversation's pictures, zoom up to 8×, pan, or hand one to the system viewer.
- Mouse and trackpad: the wheel zooms toward the pointer. With real pixels, a drag pans, and a click gives the picture the keyboard for ← → (step) and + − (zoom). Clicks need Claude Code's fullscreen layout (`/tui fullscreen`).
- Keys that work with no click: `n` `p` step, `z` `x` zoom, `w` `a` `s` `d` pan, `f` or `0` fit, `v` the system viewer, `q` or Esc close.
- Zoom crops the original picture with ImageMagick, so detail holds up as you zoom in. Past the picture's own resolution, crops are enlarged by nearest neighbour, so pixels stay sharp squares instead of the terminal's blur.
- While zoomed in, a navigator in the corner shows the whole picture with the part in view boxed.
- A strip of thumbnails runs along the bottom, the open one framed in Claude's orange; click one to open it. A short pane shows numbers instead.
- The pane matches Claude Code's own: the terminal's background, a `✕ close` button, one dim line of keys.
- Zooming makes one crop at a time, always for the latest view, and keeps the last sharp view on screen meanwhile. A crop that fails is tried again.
- `/image list` lists the pictures; before, a bare `/image` did.
- Pictures you send while Claude is working now draw too. Claude Code stores a message sent mid-turn as text alone, so the mod reads its pictures as it is submitted.

## 0.2.3 (2026-11-19)

- The mod moved to `plugins/inline-images/`, so the screenshots and docs in this repository no longer download with it. The install line is unchanged.
- The README no longer asks for `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`: mods are on by default since Claude Code 2.1.287, which ignores it.
- CI runs the mod's tests on Linux and macOS, against Claude Code 2.1.311 and the latest release. The README now names 2.1.311 as the minimum.

## 0.2.2 (2026-11-19)

- Over ssh and inside tmux, the mod sends the picture's bytes instead of a file path. A terminal on another machine, such as a plain `ssh` tab attached to the same tmux session, drew a blank box where the picture should be. Past the 2 MiB an `Image` takes, it sends the 480-pixel copy instead.

## 0.2.1 (2026-11-19)

- Pasted images decode with ImageMagick 7.1.2 and later, which refuse `inline:-` (a data URI on stdin). The bytes go through a file first.

## 0.2.0 (2026-10)

- Images you paste, images tools return and files sent with `SendUserFile`, drawn under their rows, as real pixels or block symbols, and again on `--resume`.
- `/image N` opens one at full size.

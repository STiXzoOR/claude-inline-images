# Changelog

## 0.2.3 (2026-11-19)

- The mod moved to `plugins/inline-images/`, so the screenshots and docs in this repository no longer download with it. The install line is unchanged.
- The README no longer asks for `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`: mods are on by default since Claude Code 2.1.287, which ignores it.
- CI runs the mod's tests on Linux and macOS, against Claude Code 2.1.287 and the latest release.

## 0.2.2 (2026-11-19)

- Over ssh and inside tmux, the mod sends the picture's bytes instead of a file path. A terminal on another machine, such as a plain `ssh` tab attached to the same tmux session, drew a blank box where the picture should be. Past the 2 MiB an `Image` takes, it sends the 480-pixel copy instead.

## 0.2.1 (2026-11-19)

- Pasted images decode with ImageMagick 7.1.2 and later, which refuse `inline:-` (a data URI on stdin). The bytes go through a file first.

## 0.2.0 (2026-10)

- Images you paste, images tools return and files sent with `SendUserFile`, drawn under their rows, as real pixels or block symbols, and again on `--resume`.
- `/image N` opens one at full size.

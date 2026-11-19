# inline-images

A Claude Code mod that draws images inline in the terminal transcript instead of `[Image #1]` text:

- images you paste or drag into the prompt
- images tools return (a `Read` of a picture, browser screenshots, MCP image results)
- image files Claude sends you with `SendUserFile`
- all of the above again when you `--resume` / `--continue` a conversation

Each picture is captioned `image N · W×H · /image N`. Run `/image N` (or `/image last`) to open it at full size in your image viewer, or `/image` to list them.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install inline-images --marketplace STiXzoOR/claude-inline-images
```

Answer `y` to add the marketplace, then pick a scope (user is the usual one).

From a shell:

```bash
claude plugin install inline-images --marketplace STiXzoOR/claude-inline-images
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `STiXzoOR/claude-inline-images`, then Add plugin.

Update later with `claude plugin update inline-images@claude-inline-images`, then restart Claude Code.

## Needs

- **Claude Code 2.1.311 or later.** Mods are on by default since 2.1.287, but CI tests 2.1.311 (the stable channel) and the latest release, and the tests need 2.1.311.
- **ImageMagick 7 (`magick`)** to decode. On macOS the built-in `sips` stands in when ImageMagick is missing. Ubuntu's `imagemagick` package is version 6, which has no `magick`: use the official AppImage from the ImageMagick releases, extracted with `--appimage-extract` so it needs no FUSE.

Decodes are cached by content in `$TMPDIR/claude-inline-images` and removed after 7 days. ImageMagick 7.1.2 and later refuse `inline:-` (a data URI on stdin), so pasted images are written to `<id>.src` first and decoded from there.

## How it draws

| Terminal | Drawing |
|---|---|
| kitty, Ghostty (not inside tmux/screen) | Real pixels, through Claude Code's `Image` element |
| Rex, with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` | Real pixels, as above |
| tmux or ssh, from a terminal that draws kitty images, with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` (and tmux's `allow-passthrough on`) | Real pixels, sent as the picture's bytes, so they reach every attached tmux client, wherever it runs |
| Warp, iTerm2, Terminal.app, VS Code, other tmux | Block symbols: each cell picks the best of 24 block glyphs (halves, quadrants, eighths) and two colours |

An `Image` can name a file for the terminal to read, or carry the bytes. A file name draws only where the terminal can open the file, so the mod names one only when Claude Code runs outside tmux and screen and not over ssh. Everywhere else it sends the PNG itself, or, past the 2 MiB an `Image` takes, the 480-pixel copy it keeps for block symbols. Inside tmux it always sends bytes, because any attached client may be on another machine.

Claude Code draws real pixels only in terminals whose XTVERSION name is kitty or Ghostty. Rex supports everything `Image` needs (kitty images, and Unicode placeholders), but it names itself `rex`, so it needs the override. Over ssh or inside tmux, Claude Code can't tell what the terminal outside draws, so it needs the override there too.

Set the override only where the terminal can draw the images, never in the `env` block of `~/.claude/settings.json`. There it applies in every terminal, and in one that can't draw them, images break instead of falling back to block symbols. A shell alias can set it per terminal, for example only in Rex:

```bash
alias clauded='CLAUDE_CODE_FORCE_TERMINAL_IMAGES=$([[ $TERM_PROGRAM == rex ]] && echo 1) claude'
```

On a server you reach from such a terminal, set it in that server's alias unconditionally.

Warp draws kitty images sent inline, but not by file path and not the Unicode placeholders `Image` relies on ([warpdotdev/warp#16312](https://github.com/warpdotdev/warp/pull/16312) adds them). It stays on block symbols. Last checked on Warp v0.2026.11.11.

## Settings

`/plugin configure inline-images@claude-inline-images`, or from a shell `claude plugin configure inline-images@claude-inline-images`:

- `renderer`: `auto` (default), `symbols`, `blocks` (plain half blocks), `pixels`
- `maxColumns` (64) and `maxRows` (22): the largest box a picture is drawn in

## Develop

The mod lives in `plugins/inline-images/`. Claude Code runs the copy it installs under `~/.claude/plugins/cache/`, not a clone, so to try a change, run a session with the clone's mod loaded: `claude --plugin-dir plugins/inline-images`.

```bash
claude plugin validate .                      # the marketplace
claude plugin validate plugins/inline-images  # the mod
claude plugin test plugins/inline-images
tsc -p plugins/inline-images --noEmit         # its types folder appears once Claude Code has loaded the mod from there
```

`examples/make-test-card.sh` draws `examples/test-card.png`, a card that shows the difference between pixels and block symbols at a glance: a Siemens star, text in shrinking sizes, a texture and a hue spectrum. Ask Claude to read it.

## License

MIT

import { describe, expect, test } from 'claude-code/testing'

import { clientsAreLocal } from './clients'

// A Mac: Ghostty runs a login shell that attached tmux, and sshd runs another
// shell that attached tmux too.
const PS = [
  '    1     0 /sbin/launchd',
  '  700     1 /Applications/Ghostty.app/Contents/MacOS/ghostty',
  '  701   700 /usr/bin/login',
  '  702   701 -zsh',
  '  703   702 tmux',
  '  900     1 /usr/sbin/sshd',
  '  901   900 sshd-session',
  '  902   901 -zsh',
  '  903   902 tmux',
  '  950     1 mosh-server',
  '  951   950 -zsh',
  '  952   951 tmux',
].join('\n')

describe('clientsAreLocal', () => {
  test('is true when every client was started from a terminal on this machine', () => {
    expect(clientsAreLocal('703\n', PS)).toBe(true)
  })

  test('is false when a client was attached over ssh', () => {
    expect(clientsAreLocal('703\n903\n', PS)).toBe(false)
  })

  test('is false when a client was attached over mosh', () => {
    expect(clientsAreLocal('952\n', PS)).toBe(false)
  })

  test('knows sshd by its name alone, with or without a directory', () => {
    const linux = ['    1     0 systemd', '  400     1 sshd', '  401   400 bash', '  402   401 tmux'].join('\n')

    expect(clientsAreLocal('402', linux)).toBe(false)
  })

  test('knows sshd by the title it gives itself, as macOS ps shows it', () => {
    // Copied from `ps -A -o pid=,ppid=,comm=` on macOS, attached with `ssh -t localhost tmux attach`.
    const mac = [
      '28625     1 sshd-session: me [priv]',
      '28632 28625 sshd-session: me@ttys009',
      '30881 28632 /opt/homebrew/bin/tmux',
    ].join('\n')

    expect(clientsAreLocal('30881', mac)).toBe(false)
  })

  test('knows the older sshd title too', () => {
    const old = ['  500     1 sshd: me [priv]', '  501   500 sshd: me@pts/0', '  502   501 tmux'].join('\n')

    expect(clientsAreLocal('502', old)).toBe(false)
  })

  test('does not take a program named like sshd for it', () => {
    const lookalike = ['    1     0 launchd', '  600     1 /usr/local/bin/sshd-exporter', '  601   600 tmux'].join('\n')

    expect(clientsAreLocal('601', lookalike)).toBe(true)
  })

  test('is false with no client attached', () => {
    expect(clientsAreLocal('', PS)).toBe(false)
  })

  test('is false when a client is missing from the process table', () => {
    expect(clientsAreLocal('703\n4242\n', PS)).toBe(false)
  })

  test('is false when the parents loop, rather than looking forever', () => {
    const loop = ['  10    11 tmux', '  11    10 zsh'].join('\n')

    expect(clientsAreLocal('10', loop)).toBe(false)
  })
})

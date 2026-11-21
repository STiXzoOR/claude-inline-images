/**
 * Processes that put a terminal on another machine: a tmux client started
 * under one of these was attached over ssh or mosh. sshd renames itself, so
 * `ps` may show `sshd-session: me@ttys009` or `sshd: me [priv]`: the name is
 * matched at the start, after any directory, up to a colon, space or the end.
 */
const REMOTE = /(?:^|\/)(?:sshd|sshd-session|mosh-server)(?::|\s|$)/

/** How far up a client's parents to look before giving up on it. */
const MAX_DEPTH = 64

type Proc = { ppid: number; name: string }

/** `ps -A -o pid=,ppid=,comm=` as a table by pid. */
const processTable = (ps: string) => {
  const table = new Map<number, Proc>()
  for (const line of ps.split('\n')) {
    const [, pid, ppid, name] = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line) ?? []
    if (pid === undefined || ppid === undefined || name === undefined) continue
    table.set(Number(pid), { ppid: Number(ppid), name })
  }
  return table
}

/** Whether a process was started, at any depth, by sshd or mosh-server. Unknown counts as remote. */
const startedRemotely = (pid: number, table: Map<number, Proc>) => {
  let at = pid
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (at <= 1) return false
    const proc = table.get(at)
    if (proc === undefined) return true
    if (REMOTE.test(proc.name)) return true
    at = proc.ppid
  }
  return true
}

/**
 * Whether every tmux client attached to the session runs on this machine.
 * `clients` is `tmux list-clients -F '#{client_pid}'`, `ps` the process table.
 * No clients, or a client whose parents can't be traced, count as not local,
 * so the picture's bytes go, as they would without the check.
 */
export function clientsAreLocal(clients: string, ps: string) {
  const pids = clients
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^\d+$/.test(line))
    .map(Number)
  if (pids.length === 0) return false
  const table = processTable(ps)
  return pids.every(pid => !startedRemotely(pid, table))
}

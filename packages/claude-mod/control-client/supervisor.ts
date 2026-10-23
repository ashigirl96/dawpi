import type { EngineInterface } from 'claude-code'
import type { SupervisorSnapshot } from '../types/index.d.ts'

// sun_path is about 100 bytes, so the socket cannot live under the session's long state directory.
const SOCKET_DIR = '/tmp/codex-bridge'
const EVENTS_WAIT_MS = 25_000
const MAX_POLL_MS = 30_000
const POLL_RETRIES = 5

const SUPERVISOR_STATE = { plugin: 'codex-bridge', key: 'supervisor' } as const

export type SupervisorHandle = {
  pid: number
  version: string
  socketPath: string
  isAlive: () => boolean
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

let current: Promise<SupervisorHandle> | undefined
let snapshot: SupervisorSnapshot = { phase: 'absent', cursor: 0 }

async function publish($: EngineInterface, patch: Partial<SupervisorSnapshot>) {
  snapshot = { ...snapshot, ...patch }
  await $.state.set(SUPERVISOR_STATE, snapshot).catch(() => undefined)
}

export const currentSnapshot = () => snapshot

type Request = { resolve: (h: SupervisorHandle) => void; reject: (err: Error) => void }
let wakeLauncher: ((request: Request) => void) | undefined

// Callers that arrive while a launch is in flight share its Promise, so one session never starts two Supervisors.
export function ensureSupervisor(): Promise<SupervisorHandle> {
  if (current !== undefined) return current
  const wake = wakeLauncher
  if (wake === undefined) return Promise.reject(new Error('the Supervisor launcher is not running'))
  wakeLauncher = undefined
  const launching = new Promise<SupervisorHandle>((resolve, reject) => wake({ resolve, reject }))
  current = launching
  launching.catch(() => {
    if (current === launching) current = undefined
  })
  return launching
}

// A child spawned through a tool.call's $ is killed when that dispatch is interrupted, so session.start runs this loop and every spawn goes through its $.
export async function serveLaunches($: EngineInterface) {
  for (;;) {
    const request = await new Promise<Request>(resolve => (wakeLauncher = resolve))
    const launching = current
    const forget = () => {
      if (current === launching) current = undefined
    }
    await launch($, forget).then(request.resolve, request.reject)
  }
}

async function launch($: EngineInterface, onExit: () => void): Promise<SupervisorHandle> {
  const sessionId = await $.session.id()
  const socketPath = `${SOCKET_DIR}/${sessionId}.sock`
  const main = `${$.plugin.root}/../supervisor/src/main.ts`
  await publish($, { phase: 'starting', cursor: 0, pid: undefined, exit: undefined, lastEvent: undefined })

  let alive = true
  let settle!: { resolve: (h: SupervisorHandle) => void; reject: (err: Error) => void }
  const ready = new Promise<SupervisorHandle>((resolve, reject) => (settle = { resolve, reject }))
  const child = $.process.spawn({ argv: ['bun', main, '--session', sessionId, '--socket', socketPath] })

  void (async () => {
    let buffered = ''
    let ended: { code: number | null; signal: string | null } | undefined
    try {
      for (;;) {
        const piece = await child.next()
        if (piece.done) {
          ended = piece.value
          break
        }
        if (piece.value.stream === 'stderr') {
          $.ui.log(`supervisor stderr: ${piece.value.text}`, { to: 'debug' })
          continue
        }
        buffered += piece.value.text
        let nl: number
        while ((nl = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, nl)
          buffered = buffered.slice(nl + 1)
          $.ui.log(`supervisor: ${line}`, { to: 'debug' })
          onLine(line)
        }
      }
    } catch (err) {
      settle.reject(err instanceof Error ? err : new Error(String(err)))
    } finally {
      alive = false
      settle.reject(new Error(`Supervisor exited before it was ready (${JSON.stringify(ended ?? null)})`))
      onExit()
      await publish($, { phase: 'exited', exit: ended ?? { code: null, signal: null } })
    }
  })()

  function onLine(line: string) {
    let msg: { kind?: string; pid?: number; version?: string; message?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.kind === 'ready' && typeof msg.pid === 'number') {
      settle.resolve({ pid: msg.pid, version: String(msg.version), socketPath, isAlive: () => alive })
    } else if (msg.kind === 'error') {
      settle.reject(new Error(`Supervisor failed to start: ${msg.message}`))
    }
  }

  const handle = await ready
  await publish($, { phase: 'running', pid: handle.pid, version: handle.version })
  void pollEvents($, handle)
  return handle
}

export async function request<T>(
  $: EngineInterface,
  handle: SupervisorHandle,
  path: string,
  body?: unknown,
): Promise<Outcome<T>> {
  const res = await $.http.fetch(`http://supervisor${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    socketPath: handle.socketPath,
  })
  return JSON.parse(res.text) as Outcome<T>
}

export type EventPage = { cursor: number; more: boolean; events: { seq: number; kind: string; observedAt: string }[] }

export function pollOnce($: EngineInterface, handle: SupervisorHandle, after: number, waitMs: number) {
  return request<EventPage>($, handle, `/events?after=${after}&waitMs=${Math.min(Math.max(0, waitMs), MAX_POLL_MS)}`)
}

async function pollEvents($: EngineInterface, handle: SupervisorHandle) {
  let cursor = 0
  let failures = 0
  while (handle.isAlive()) {
    try {
      const page = await pollOnce($, handle, cursor, EVENTS_WAIT_MS)
      if (!page.ok) {
        $.ui.log(`events poll refused: ${page.error.code} ${page.error.message}`, { to: 'debug' })
        return
      }
      failures = 0
      cursor = page.value.cursor
      const last = page.value.events.at(-1)
      if (last !== undefined) {
        await publish($, { cursor, lastEvent: { seq: last.seq, kind: last.kind, observedAt: last.observedAt } })
      }
    } catch (err) {
      if (!handle.isAlive() || ++failures > POLL_RETRIES) return
      $.ui.log(`events poll failed: ${String(err)}`, { to: 'debug' })
      const paused = await $.process.run(['sleep', '1']).then(
        () => true,
        () => false,
      )
      if (!paused) return
    }
  }
}

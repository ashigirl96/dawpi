import type { EngineInterface, Register } from 'claude-code'
import { serveLaunches, currentSnapshot, ensureSupervisor, pollOnce, request, type SupervisorHandle } from '../control-client/supervisor.ts'

const DIAGNOSE = 'mcp__codex-bridge__diagnose'
const MAX_DIAGNOSE_WAIT_MS = 600_000

type Raced<T> = { aborted: true } | { aborted: false; value: T }

// $.http.fetch takes no signal, so an abort can only stop our wait; the Supervisor ends the request within its 30 s cap.
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<Raced<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true })
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ aborted: true })
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve({ aborted: false, value })
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

async function waitForEvents($: EngineInterface, handle: SupervisorHandle, after: number, waitMs: number, signal: AbortSignal) {
  const t0 = Date.now()
  let cursor = after
  let polls = 0
  const kinds: string[] = []
  while (Date.now() - t0 < waitMs) {
    polls++
    const raced = await raceAbort(pollOnce($, handle, cursor, waitMs - (Date.now() - t0)), signal)
    if (raced.aborted) {
      $.ui.log(`diagnose: long poll stopped by next.signal after ${Date.now() - t0} ms (poll ${polls})`, { to: 'debug' })
      return { stoppedBy: 'abort', elapsedMs: Date.now() - t0, polls, kinds }
    }
    if (!raced.value.ok) return { stoppedBy: 'refused', error: raced.value.error, polls, kinds }
    cursor = raced.value.value.cursor
    kinds.push(...raced.value.value.events.map(e => e.kind))
  }
  return { stoppedBy: 'timeout', elapsedMs: Date.now() - t0, polls, kinds }
}

function readWaitMs(input: unknown): number {
  if (input === undefined) return 0
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > MAX_DIAGNOSE_WAIT_MS) {
    throw new Error(`waitMs must be an integer from 0 to ${MAX_DIAGNOSE_WAIT_MS}`)
  }
  return input
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void serveLaunches($)
    await $.tool.register({
      name: 'diagnose',
      description:
        'Codex Bridge diagnostics: starts the Supervisor if needed and reports its version and state. ' +
        'With waitMs, also long-polls the Supervisor events for up to that many milliseconds.',
      inputSchema: {
        type: 'object',
        properties: { waitMs: { type: 'integer', minimum: 0, maximum: MAX_DIAGNOSE_WAIT_MS } },
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.check', { tool: DIAGNOSE }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: DIAGNOSE }, async ($, e, next) => {
    const waitMs = readWaitMs((e as { waitMs?: unknown }).waitMs)
    const handle = await ensureSupervisor()
    const status = await request<{ cursor: number }>($, handle, '/command', { op: 'status' })
    if (!status.ok) return { isError: true, result: status.error, text: `${status.error.code}: ${status.error.message}` }
    const waited = waitMs > 0 ? await waitForEvents($, handle, status.value.cursor, waitMs, next.signal) : undefined
    return { result: JSON.stringify({ supervisor: status.value, snapshot: currentSnapshot(), waited }) }
  }).catch(($, e, next) => {
    const message = next.error instanceof Error ? next.error.message : String(next.error)
    return { isError: true, result: message, text: `codex-bridge diagnose failed: ${message}` }
  })
}

import type { EngineInterface, Register, TurnStepResult } from 'claude-code'
import { DELEGATE_INPUT_SCHEMA } from '../schemas/delegate-input.ts'
import { currentSupervisor, ensureSupervisor, request, type SupervisorHandle } from '../control-client/supervisor.ts'
import { raceAbort } from './race-abort.ts'

export const DELEGATE = 'mcp__codex-bridge__delegate'
export const WORKER = 'codex-bridge:worker'
const DIAGNOSE = 'mcp__codex-bridge__diagnose'
const STEP_WAIT_MS = 25_000
const STEP_CAP = 50
// next(e) of a registered tool reaches no implementation, so this error is what a call that passed the host's check comes back with.
const PASSED_HOST_CHECK = 'no tool.call hook answered this call'
const ENVELOPE_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])

type Outcome<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
type StepAction =
  | { kind: 'pending'; status: string }
  | { kind: 'report'; via: 'text'; message: string }
  | { kind: 'report'; via: 'handback'; message: string; toolUseId: string }
  | { kind: 'end'; text: string }
type Binding = { runId: string; handle: SupervisorHandle }

// Written synchronously right after the host starts a Worker, so a Host Step never finds its Worker unknown.
const workers = new Map<string, Promise<Binding>>()
const spawning = new Map<string, Promise<string | undefined>>()
const notWorkers = new Set<string>()
const steps = new Map<string, number>()

async function* answerText(e: { turnId: string; index: number }, text: string): AsyncGenerator<any, TurnStepResult> {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}

async function* callTool(
  e: { turnId: string; index: number },
  id: string,
  name: string,
  input: Record<string, unknown>,
): AsyncGenerator<any, TurnStepResult> {
  yield { kind: 'tool', index: 0, id, name }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null }
}

const errorText = (error: { code: string; message: string }) => `codex-bridge ${error.code}: ${error.message}`

// A hook's error reaches .catch as a plain { name, message } object, not an Error.
const messageOf = (err: unknown) => {
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(err)
}

function passedHostCheck(verdict: unknown): boolean {
  const v = verdict as { isError?: boolean; text?: unknown }
  return v.isError === true && typeof v.text === 'string' && v.text.includes(PASSED_HOST_CHECK)
}

function delegateInputOf(e: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(e).filter(([key]) => !ENVELOPE_KEYS.has(key)))
}

async function callerDepth($: EngineInterface, agentId: string | undefined): Promise<number> {
  if (agentId === undefined) return 0
  const parents = new Map((await $.agent.list()).map(a => [a.id, a.parentId]))
  let depth = 0
  for (let id: string | undefined = agentId; id !== undefined && depth <= 8; id = parents.get(id)) depth++
  return depth
}

function launchInstructions(runId: string): string {
  return (
    `Now call the Agent tool with subagent_type "${WORKER}", description "Codex Bridge ${runId}", ` +
    `and prompt set to exactly "${runId}" with nothing else. The Worker's Report is the result of this delegation.`
  )
}

async function prepareRun($: EngineInterface, e: Record<string, unknown>) {
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined
  const depth = await callerDepth($, agentId)
  const handle = await ensureSupervisor()
  const prepared = await request<{ runId: string; status: string; depth: number }>($, handle, '/command', {
    op: 'run.prepare',
    caller: { agentId: agentId ?? null, depth },
    input: delegateInputOf(e),
  })
  // The host checks a tool's result against an output shape that takes text, not an object.
  if (!prepared.ok) return { isError: true as const, result: JSON.stringify(prepared), text: errorText(prepared.error) }
  const { runId, status } = prepared.value
  $.ui.log(`codex-bridge: prepared ${runId} for ${agentId ?? 'main'} at depth ${prepared.value.depth}`, { to: 'debug' })
  return { result: JSON.stringify({ runId, status, instructions: launchInstructions(runId) }) }
}

async function bindWorker(
  $: EngineInterface,
  handle: SupervisorHandle,
  runId: string,
  agentId: string,
  permissionMode: string | undefined,
): Promise<Binding> {
  const bound = await request($, handle, '/command', { op: 'run.bind', runId, agentId, permissionMode })
  if (!bound.ok) throw new Error(errorText(bound.error))
  $.ui.log(`codex-bridge: bound ${agentId} to ${runId} (permissionMode ${permissionMode ?? 'unknown'})`, { to: 'debug' })
  return { runId, handle }
}

// The host may run the Worker's first Host Step before agent.spawn's next(e) settles; then the runId is the Worker's prompt.
async function bindingOf($: EngineInterface, agentId: string): Promise<Promise<Binding> | 'not-worker' | undefined> {
  const known = workers.get(agentId)
  if (known !== undefined) return known
  if (notWorkers.has(agentId)) return 'not-worker'
  const info = (await $.agent.list()).find(a => a.id === agentId)
  if (info === undefined) {
    await Promise.all(spawning.values())
    return workers.get(agentId) ?? 'not-worker'
  }
  if (info.type !== WORKER) {
    notWorkers.add(agentId)
    return 'not-worker'
  }
  const rows = await $.session.messages({ agentId })
  const prompt = Array.isArray(rows) ? rows.find(r => r.role === 'user')?.text?.trim() : undefined
  if (prompt !== undefined) await spawning.get(prompt)
  return workers.get(agentId)
}

async function nextAction($: EngineInterface, binding: Binding, agentId: string, signal: AbortSignal) {
  for (;;) {
    const raced = await raceAbort(
      request<StepAction>($, binding.handle, '/command', { op: 'worker.step', agentId, waitMs: STEP_WAIT_MS }),
      signal,
    )
    if (raced.aborted) return undefined
    const outcome: Outcome<StepAction> = raced.value
    if (!outcome.ok || outcome.value.kind !== 'pending') return outcome
  }
}

export async function registerDelegation($: EngineInterface) {
  await $.tool.register({
    name: 'delegate',
    description:
      'Delegate a task to Codex through the Codex Bridge. Step 1 of 2: this tool prepares a Run and returns its runId. ' +
      `Step 2: call the Agent tool with subagent_type "${WORKER}" and prompt set to exactly that runId, nothing else.`,
    inputSchema: DELEGATE_INPUT_SCHEMA,
    isDeferred: false,
  })
  await $.agent.register({
    name: 'worker',
    description: `Codex Bridge Worker. Launch it only as step 2 of ${DELEGATE}, with prompt set to exactly the runId that tool returned.`,
    prompt: 'You are a Codex Bridge Worker. The Codex Bridge answers for you, so do nothing: reply with exactly "idle" and never call tools.',
    tools: ['Agent', 'Bash', DIAGNOSE],
    model: 'haiku',
    omitClaudeMd: true,
  })
}

export function registerRuns(on: Parameters<Register>[0]) {
  on('tool.call', { tool: DELEGATE }, async ($, e, next) => {
    const verdict = await next(e)
    if (!passedHostCheck(verdict)) {
      $.ui.log(`codex-bridge: the host refused delegate: ${JSON.stringify(verdict).slice(0, 300)}`, { to: 'debug' })
      return verdict
    }
    return prepareRun($, e as unknown as Record<string, unknown>)
  }).catch(($, e, next) => {
    const message = messageOf(next.error)
    return { isError: true, result: message, text: `codex-bridge delegate failed: ${message}` }
  })

  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const input = (e.input ?? {}) as { subagent_type?: unknown; prompt?: unknown }
    if (input.subagent_type !== WORKER) return next(e)
    const supervisor = currentSupervisor()
    if (supervisor === undefined) return { decision: 'deny', reason: 'codex-bridge: no Run was prepared; call delegate first' }
    const admitted = await request($, await supervisor, '/command', {
      op: 'run.admit',
      runId: String(input.prompt ?? '').trim(),
      callerAgentId: e.agentId ?? null,
    })
    $.ui.log(`codex-bridge: tool.check Agent from ${e.agentId ?? 'main'}: ${admitted.ok ? 'allow' : admitted.error.code}`, { to: 'debug' })
    return admitted.ok
      ? { decision: 'allow', reason: 'codex-bridge: step 2 of a delegate this caller prepared' }
      : { decision: 'deny', reason: errorText(admitted.error) }
  }).catch(() => ({ decision: 'deny', reason: 'codex-bridge could not check this Worker launch' }))

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== WORKER || e.resume !== undefined) return next(e)
    const runId = e.prompt.trim()
    const supervisor = currentSupervisor()
    if (supervisor === undefined) return { deny: 'codex-bridge: no Run was prepared; call delegate first' }
    const handle = await supervisor
    const claimed = await request($, handle, '/command', { op: 'run.claim', runId, callerAgentId: e.parentAgentId ?? null })
    if (!claimed.ok) {
      $.ui.log(`codex-bridge: refused a Worker for ${runId.slice(0, 80)}: ${claimed.error.code}`, { to: 'debug' })
      return { deny: errorText(claimed.error) }
    }
    let started!: (agentId: string | undefined) => void
    spawning.set(runId, new Promise(resolve => (started = resolve)))
    const spawned = await next(e)
    const agentId = spawned.agentId
    if (spawned.deny !== undefined || agentId === undefined) {
      started(undefined)
      spawning.delete(runId)
      await request($, handle, '/command', { op: 'run.abandon', runId, reason: spawned.deny ?? 'no agentId' })
      return spawned
    }
    const binding = bindWorker($, handle, runId, agentId, e.permissionMode)
    workers.set(agentId, binding)
    started(agentId)
    spawning.delete(runId)
    // A failed bind leaves the Run starting, so no second Worker can claim it; the Worker's Host Step reports the failure.
    await binding.catch(err => $.ui.log(`codex-bridge: bind of ${agentId} failed: ${messageOf(err)}`, { to: 'debug' }))
    return spawned
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId === undefined) return yield* next(e)
    const found = await bindingOf($, agentId)
    if (found === 'not-worker') return yield* next(e)
    if (found === undefined) return yield* answerText(e, 'codex-bridge: this Worker has no Run in this session')
    const n = (steps.get(agentId) ?? 0) + 1
    steps.set(agentId, n)
    if (n > STEP_CAP) return yield* answerText(e, `codex-bridge: Host Step cap ${STEP_CAP} reached`)
    const binding = await found
    const outcome = await nextAction($, binding, agentId, next.signal)
    if (outcome === undefined) return yield* answerText(e, 'codex-bridge: the Host Step was interrupted')
    if (!outcome.ok) return yield* answerText(e, errorText(outcome.error))
    const action = outcome.value
    $.ui.log(`codex-bridge: Host Step ${n} of ${agentId} (${binding.runId}): ${action.kind}${action.kind === 'report' ? ` via ${action.via}` : ''}`, { to: 'debug' })
    if (action.kind === 'end') return yield* answerText(e, action.text)
    if (action.kind === 'report' && action.via === 'handback') {
      return yield* callTool(e, action.toolUseId, 'SubagentHandback', { message: action.message })
    }
    if (action.kind === 'report') return yield* answerText(e, action.message)
    return yield* answerText(e, `codex-bridge: unexpected Host Step ${action.kind}`)
  }).catch(async function* ($, e, next) {
    return yield* answerText(e, `codex-bridge error: ${messageOf(next.error)}`)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined && workers.has(e.agentId)) {
      $.ui.log(`codex-bridge: Worker ${e.agentId} turn complete (${e.reason}), usage ${JSON.stringify(e.usage ?? null)}`, { to: 'debug' })
    }
    return next(e)
  })
}

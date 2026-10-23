// PROTOTYPE (dawpi #11): throwaway. Answers how the top-level worker of a Run
// (the Codex worker right under main) starts in auto mode, and whether the
// launch input survives as a schema and prepare → bind → activate holds.
// Codex is stubbed: activate only flips the Run's state.
import type { Register, EngineInterface, TurnStepResult } from 'claude-code'

const VARIANT_FILE = '/tmp/cbp11-variant'
const WORKER = 'cbp11:worker'
const STEP_CAP = 12

// A: delegate prepares, then main calls Agent with the runId.
// B: main calls Agent with the launch input as JSON; agent.spawn validates and prepares.
// C: delegate's tool.call spawns with $.agent.spawn (the path #4 saw denied).
type Variant = 'A' | 'B' | 'C'

const LAUNCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['task', 'execution'],
  properties: {
    task: {
      type: 'object', additionalProperties: false, required: ['title', 'prompt'],
      properties: { title: { type: 'string' }, prompt: { type: 'string' } },
    },
    execution: {
      type: 'object', additionalProperties: false, required: ['model'],
      properties: { model: { type: 'string' }, effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] } },
    },
    workspace: {
      type: 'object', additionalProperties: false,
      properties: { directory: { type: 'string' }, isolation: { type: 'string', enum: ['shared-read', 'isolated-write'] } },
    },
    permissions: {
      type: 'object', additionalProperties: false,
      properties: { sandbox: { type: 'string', enum: ['read-only', 'workspace-write'] }, approvalPolicy: { type: 'string', enum: ['on-request', 'never'] } },
    },
  },
} as const

type Schema = { type?: string; properties?: Record<string, Schema>; required?: readonly string[]; additionalProperties?: boolean; enum?: readonly string[] }

// The engine is not trusted to enforce inputSchema, so the Mod validates on its own.
const validate = (v: unknown, s: Schema, path = '$'): string[] => {
  if (s.type === 'object') {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${path}: expected object`]
    const o = v as Record<string, unknown>
    const errs: string[] = []
    for (const k of s.required ?? []) if (!(k in o)) errs.push(`${path}.${k}: required`)
    for (const [k, x] of Object.entries(o)) {
      const sub = s.properties?.[k]
      if (sub === undefined) { if (s.additionalProperties === false) errs.push(`${path}.${k}: unknown property`); continue }
      errs.push(...validate(x, sub, `${path}.${k}`))
    }
    return errs
  }
  if (s.type === 'string') {
    if (typeof v !== 'string') return [`${path}: expected string`]
    if (s.enum && !s.enum.includes(v)) return [`${path}: one of ${s.enum.join(', ')}`]
  }
  return []
}

type RunState = 'prepared' | 'binding' | 'bound' | 'active' | 'reported'
type Run = {
  runId: string
  state: RunState
  input: unknown
  callerAgentId: string | null
  agentId?: string
  permissionMode?: string
  t: Record<string, number>
}

const runs = new Map<string, Run>()
const runByAgent = new Map<string, Run>()
const steps = new Map<string, number>()

let variant: Variant = 'A'
let LOG = '/tmp/cbp11-log.json'
const entries: unknown[] = []
let flushing = Promise.resolve()
const log = ($: EngineInterface, entry: Record<string, unknown>) => {
  entries.push({ t: Date.now(), ...entry })
  const snapshot = JSON.stringify(entries, null, 2)
  flushing = flushing.then(() => $.fs.write(LOG, snapshot)).catch(() => undefined)
}

const newRunId = () => `run_${Math.random().toString(36).slice(2, 10)}`

const prepare = (input: unknown, callerAgentId: string | null): Run => {
  const run: Run = { runId: newRunId(), state: 'prepared', input, callerAgentId, t: { prepared: Date.now() } }
  runs.set(run.runId, run)
  return run
}

const toolUseId = () => `toolu_cbp11${Math.random().toString(36).slice(2, 12)}`

async function* answerText(e: { turnId: string; index: number }, text: string): AsyncGenerator<any, TurnStepResult> {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}

async function* callTool(e: { turnId: string; index: number }, name: string, input: Record<string, unknown>): AsyncGenerator<any, TurnStepResult> {
  yield { kind: 'tool', index: 0, id: toolUseId(), name }
  yield { kind: 'input', index: 0, json: JSON.stringify(input) }
  yield { kind: 'stop', stopReason: 'tool_use', usage: null }
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null }
}

const DELEGATE_DESC: Record<Variant, string> = {
  A: [
    'PROTOTYPE (cbp11). Delegate a task to a Codex agent. Step 1 of 2: this tool validates the launch input and prepares a Run.',
    'It returns a runId. Step 2: immediately call the Agent tool with subagent_type "cbp11:worker", description "cbp11 <title>", and prompt set to exactly the runId, nothing else.',
  ].join(' '),
  B: 'PROTOTYPE (cbp11). Not used in this variant; launch with the Agent tool instead.',
  C: 'PROTOTYPE (cbp11). Delegate a task to a Codex agent. Validates the launch input and starts the agent itself.',
}

const WORKER_DESC: Record<Variant, string> = {
  A: 'PROTOTYPE Codex worker for cbp11. Never launch it on your own: only as step 2 of mcp__cbp11__delegate, with prompt set to exactly the runId that tool returned.',
  B: [
    'PROTOTYPE Codex worker for cbp11. Launch it to delegate a task to a Codex agent.',
    'The prompt must be ONLY a JSON object (no prose, no code fence) matching this JSON Schema:',
    JSON.stringify(LAUNCH_SCHEMA),
    'Use description "cbp11 <task.title>".',
  ].join(' '),
  C: 'PROTOTYPE Codex worker for cbp11; started by mcp__cbp11__delegate only. Never launch it with the Agent tool.',
}

const findRunFromConversation = async ($: EngineInterface, agentId: string) => {
  const api = JSON.stringify(await $.session.messages({ agentId, as: 'api' }))
  const id = api.match(/run_[a-z0-9]{8}/)?.[0]
  return id === undefined ? undefined : runs.get(id)
}

const isReportedVia =(mode: string | undefined) => (mode === 'auto' ? 'SubagentHandback' : 'text')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const v = (await $.fs.read(VARIANT_FILE).catch(() => 'A')).trim()
    variant = (['A', 'B', 'C'].includes(v) ? v : 'A') as Variant
    LOG = `/tmp/cbp11-${variant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    if (variant !== 'B') {
      await $.tool.register({ name: 'delegate', description: DELEGATE_DESC[variant], inputSchema: LAUNCH_SCHEMA as unknown as Record<string, unknown>, isDeferred: false })
    }
    await $.agent.register({
      name: 'worker',
      description: WORKER_DESC[variant],
      prompt: 'You are a fallback probe. Reply with exactly the single word FALLBACK and nothing else. Never call tools.',
      tools: [],
      model: 'haiku',
      omitClaudeMd: true,
    })
    log($, { ev: 'session.start', variant })
    return next(e)
  })

  on('tool.check', { tool: /^mcp__cbp11__delegate$/ }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: /^mcp__cbp11__delegate$/ }, async ($, e) => {
    const { tool, tool_use_id, agentId, ...input } = e as Record<string, unknown>
    const errors = validate(input, LAUNCH_SCHEMA as Schema)
    log($, { ev: 'delegate.call', caller: agentId ?? 'main', input, errors })
    if (errors.length > 0) return { deny: `invalid launch input: ${errors.join('; ')}` }
    const run = prepare(input, (agentId as string | undefined) ?? null)
    if (variant === 'A') {
      return { result: `Prepared ${run.runId}. Now call the Agent tool with subagent_type "cbp11:worker", description "cbp11 ${(input as any).task.title}", prompt "${run.runId}".` }
    }
    const t0 = Date.now()
    const spawned = await $.agent.spawn({ subagentType: WORKER, description: `cbp11 ${(input as any).task.title}`, prompt: run.runId })
    log($, { ev: 'C.spawn', runId: run.runId, elapsedMs: Date.now() - t0, spawned })
    if (spawned.deny !== undefined) return { deny: `spawn refused: ${spawned.deny}` }
    return { result: `Started ${run.runId} as ${spawned.agentId}.` }
  })

  on('agent.offer', async ($, e, next) => {
    const r = await next(e)
    if (e.agent === WORKER) log($, { ev: 'agent.offer', agent: e.agent, result: r })
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== WORKER) return next(e)
    const base = { caller: e.parentAgentId ?? 'main', permissionMode: e.permissionMode, background: e.background, name: e.name, resume: e.resume ?? null }
    if (e.resume !== undefined) {
      log($, { ev: 'spawn.resume', ...base })
      return next(e)
    }
    let run: Run | undefined
    if (variant === 'B') {
      let input: unknown
      try { input = JSON.parse(e.prompt) } catch (err) {
        log($, { ev: 'spawn.deny', reason: 'not json', ...base, prompt: e.prompt.slice(0, 500) })
        return { deny: `cbp11:worker prompt must be only a JSON launch input: ${(err as Error).message}` }
      }
      const errors = validate(input, LAUNCH_SCHEMA as Schema)
      if (errors.length > 0) {
        log($, { ev: 'spawn.deny', reason: 'schema', errors, ...base })
        return { deny: `invalid launch input: ${errors.join('; ')}` }
      }
      run = prepare(input, e.parentAgentId ?? null)
    } else {
      run = runs.get(e.prompt.trim())
      const why = run === undefined ? 'unknown runId' : run.state !== 'prepared' ? `run is ${run.state}` : run.callerAgentId !== (e.parentAgentId ?? null) ? 'caller mismatch' : undefined
      if (why !== undefined || run === undefined) {
        log($, { ev: 'spawn.deny', reason: why, ...base, prompt: e.prompt.slice(0, 200) })
        return { deny: `cbp11:worker refused (${why}). Launch it only through mcp__cbp11__delegate.` }
      }
    }
    run.state = 'binding'
    run.permissionMode = e.permissionMode
    run.t.spawnHook = Date.now()
    // The worker's conversation names its Run, so a first step that beats `next` can still find it.
    const r = await next({ ...e, prompt: run.runId })
    run.t.spawnResolved = Date.now()
    if (r.deny !== undefined) {
      run.state = 'prepared'
      log($, { ev: 'spawn.denied-by-core', runId: run.runId, deny: r.deny, ...base })
      return r
    }
    if (r.agentId !== undefined) {
      run.agentId = r.agentId
      runByAgent.set(r.agentId, run)
      if (run.state === 'binding') run.state = 'bound'
    }
    log($, { ev: 'spawn.bound', runId: run.runId, agentId: r.agentId, model: r.model, ...base, stateAfter: run.state, ms: run.t.spawnResolved - run.t.spawnHook })
    return r
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type !== WORKER) return next(e)
    const t0 = Date.now()
    const r = await next(e)
    log($, { ev: 'agent.result', caller: e.agentId ?? 'main', input: { description: e.description, prompt: String(e.prompt).slice(0, 300), run_in_background: (e as any).run_in_background }, elapsedMs: Date.now() - t0, result: r })
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    let run = runByAgent.get(id)
    const boundBySpawn = run !== undefined
    if (run === undefined) {
      const info = (await $.agent.list()).find(a => a.id === id)
      if (!info?.description.startsWith('cbp11')) return yield* next(e)
      run = await findRunFromConversation($, id)
      log($, { ev: 'step.before-bind', agentId: id, index: e.index, foundInConversation: run?.runId ?? null, runState: run?.state ?? null })
      if (run === undefined) return yield* answerText(e, 'cbp11: no Run for this worker; refusing to run')
      if (run.state !== 'binding' && run.state !== 'bound') return yield* answerText(e, `cbp11: Run ${run.runId} is ${run.state}; refusing to run`)
      run.agentId = id
      runByAgent.set(id, run)
      run.state = 'bound'
    }
    const n = (steps.get(id) ?? 0) + 1
    steps.set(id, n)
    log($, { ev: 'step.seen', agentId: id, runId: run.runId, boundBySpawn, index: e.index, n, state: run.state, budgetMs: next.budget.remainingMs })
    if (n > STEP_CAP) return yield* answerText(e, `cbp11: step cap ${STEP_CAP} reached`)

    if (run.state === 'bound') {
      run.state = 'active'
      run.t.activated = Date.now()
      log($, { ev: 'activate', runId: run.runId, agentId: id, input: run.input, timeline: run.t })
    }
    if (run.state === 'active') {
      run.state = 'reported'
      const message = `cbp11 ${run.runId}: (stub Codex) received ${JSON.stringify(run.input)}`
      if (isReportedVia(run.permissionMode) === 'SubagentHandback') return yield* callTool(e, 'SubagentHandback', { message })
      return yield* answerText(e, message)
    }
    return yield* answerText(e, `cbp11 ${run.runId}: already reported`)
  }).catch(async function* ($, e, next) {
    log($, { ev: 'step.caught', agentId: e.agentId, index: e.index, error: String(next.error?.message ?? next.error) })
    return yield* answerText(e, `cbp11 error: ${next.error.message}`)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined && runByAgent.has(e.agentId)) log($, { ev: 'turn.complete', agentId: e.agentId, reason: e.reason, answer: e.answer, usage: e.usage ?? null })
    return next(e)
  })
}

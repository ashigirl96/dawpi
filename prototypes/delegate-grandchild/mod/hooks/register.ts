// PROTOTYPE (dawpi #12): throwaway. Answers whether a Codex `bridge_delegate`
// call, held unanswered, can be turned into the calling worker's own `Agent`
// tool call, bound to a prepared Run by the `agent.spawn` hook, and answered only
// after the bind; and whether the same path reaches a grandchild (main → A → B → C)
// and stops at the host's depth limit (C asking for D).
import type { Register, EngineInterface, TurnStepResult } from 'claude-code'

const DIR = '/tmp/cbp12'
const SOCKET = `${DIR}/r.sock`
const WORK = '/tmp/cbp12-work'
const VARIANT_FILE = '/tmp/cbp12-variant'
const WORKER = 'cbp12:worker'
const MODEL = 'gpt-5.6-luna'
const STEP_CAP = 30
const POLL_MS = 8000
const STEP_DEADLINE_MS = 300_000

// normal: every caller is recorded truthfully.
// mismatch: the Run that Codex B asks for is recorded with A's worker as caller,
// so B's worker's `Agent` must be refused by the caller check.
type Variant = 'normal' | 'mismatch'

type OpState = 'queued' | 'dispatched' | 'answered' | 'failed'
type Op = { childRunId: string; rpcId: number; callId: string; state: OpState; t: { received: number; dispatched: number; answered: number } }

type RunState = 'prepared' | 'binding' | 'bound' | 'active' | 'codex-done' | 'reported' | 'failed'
type Run = {
  runId: string
  depth: number
  task: string
  state: RunState
  callerAgentId: string | null
  agentId?: string
  parentRunId?: string
  permissionMode?: string
  threadId?: string
  cursor: number
  ops: Op[]
  codexAnswer?: string
  turnStatus?: string
  t: Record<string, number>
}

const TERMINAL: readonly RunState[] = ['reported', 'failed']

const runs = new Map<string, Run>()
const runByAgent = new Map<string, Run>()
const steps = new Map<string, number>()

let variant: Variant = 'normal'
let LOG = `${DIR}/log.json`
const entries: unknown[] = []
let flushing = Promise.resolve()
const log = ($: EngineInterface, entry: Record<string, unknown>) => {
  entries.push({ t: Date.now(), ...entry })
  const snapshot = JSON.stringify(entries, null, 2)
  flushing = flushing.then(() => $.fs.write(LOG, snapshot)).catch(() => undefined)
}

const newRunId = () => `run_${Math.random().toString(36).slice(2, 10)}`
const toolUseId = () => `toolu_cbp12${Math.random().toString(36).slice(2, 12)}`

const prepare = (task: string, depth: number, callerAgentId: string | null, parentRunId?: string): Run => {
  const run: Run = { runId: newRunId(), depth, task, state: 'prepared', callerAgentId, parentRunId, cursor: 0, ops: [], t: { prepared: Date.now() } }
  runs.set(run.runId, run)
  return run
}

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

const rpc = async ($: EngineInterface, path: string, body?: unknown) => {
  const res = await $.http.fetch(`http://relay${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    socketPath: SOCKET,
  })
  return JSON.parse(res.text)
}

// `$.clock.sleep` bills the hook's budget; a `$.process.run` wait does not.
const pause = ($: EngineInterface, seconds: number) => $.process.run(['sleep', String(seconds)])

let relayUp: Promise<unknown> | undefined
const startRelay = async ($: EngineInterface) => {
  await $.process.run(['mkdir', '-p', '-m', '700', DIR])
  await $.process.run(['mkdir', '-p', WORK])
  await $.process.run(['rm', '-f', SOCKET])
  const relay = $.process.spawn({ argv: ['bun', `${$.plugin.root}/relay.ts`, SOCKET] })
  void (async () => {
    for await (const { stream, text } of relay) log($, { ev: 'relay.output', stream, text })
    log($, { ev: 'relay.loop.ended' })
  })()
  for (let i = 0; i < 50; i++) {
    try {
      const health = await rpc($, '/health')
      log($, { ev: 'relay.up', health })
      return health
    } catch (err) {
      if (i === 49) throw err
      await pause($, 0.2)
    }
  }
}
const ensureRelay = ($: EngineInterface) => (relayUp ??= startRelay($))

const BRIDGE_DELEGATE = {
  type: 'function',
  name: 'bridge_delegate',
  description: 'Delegate a sub-task to another Codex agent managed by the Bridge. Returns a runId right away; it does not wait for the sub-task to finish.',
  inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
}

const codexPrompt = (run: Run) => [
  `You are level ${run.depth} of a delegation test.`,
  `Call the bridge_delegate tool exactly once with {"task":"level ${run.depth + 1}"}.`,
  'Then reply with only the text the tool returned, nothing else. Do not run any other tool.',
].join(' ')

const activate = async ($: EngineInterface, run: Run) => {
  await ensureRelay($)
  const thread = await rpc($, '/call', {
    method: 'thread/start',
    params: {
      model: MODEL, ephemeral: true, cwd: WORK, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
      dynamicTools: [BRIDGE_DELEGATE],
    },
  })
  run.threadId = thread.result?.thread?.id
  if (run.threadId === undefined) throw new Error(`thread/start failed: ${JSON.stringify(thread)}`)
  run.cursor = (await rpc($, '/events?after=0&waitMs=0')).cursor
  const turn = await rpc($, '/call', {
    method: 'turn/start',
    params: { threadId: run.threadId, effort: 'low', approvalsReviewer: 'user', input: [{ type: 'text', text: codexPrompt(run), text_elements: [] }] },
  })
  run.state = 'active'
  run.t.activated = Date.now()
  log($, { ev: 'activate', runId: run.runId, depth: run.depth, threadId: run.threadId, approvalsReviewer: thread.result?.approvalsReviewer, turn: turn.result?.turn?.id ?? turn })
}

const answerCodex = async ($: EngineInterface, op: Op, success: boolean, text: string) => {
  await rpc($, '/send', { id: op.rpcId, result: { contentItems: [{ type: 'inputText', text }], success } })
  op.t.answered = Date.now()
  op.state = success ? 'answered' : 'failed'
}

type Polled = { kind: 'delegate'; op: Op } | { kind: 'done' } | { kind: 'deadline' }

// Reads this Run's Codex events from its own cursor; a delegate request stops
// the read right after itself, so the Host Step can hand the spawn back to the host.
const pollCodex = async ($: EngineInterface, run: Run, agentId: string, budget: () => number): Promise<Polled> => {
  const t0 = Date.now()
  while (Date.now() - t0 < STEP_DEADLINE_MS) {
    const page = await rpc($, `/events?after=${run.cursor}&waitMs=${POLL_MS}`)
    log($, { ev: 'poll', runId: run.runId, cursor: run.cursor, waitedMs: page.waitedMs, got: page.events.length, budgetMs: budget() })
    for (const { seq, msg } of page.events) {
      run.cursor = seq
      if (msg.params?.threadId !== run.threadId) continue
      if (msg.method === 'item/tool/call') {
        log($, { ev: 'codex.request', runId: run.runId, msg })
        if (msg.params.tool !== 'bridge_delegate') {
          await rpc($, '/send', { id: msg.id, result: { contentItems: [{ type: 'inputText', text: 'unknown tool' }], success: false } })
          continue
        }
        const caller = variant === 'mismatch' && run.depth === 2
          ? (runs.get(run.parentRunId ?? '')?.agentId ?? null)
          : agentId
        const child = prepare(String(msg.params.arguments?.task ?? ''), run.depth + 1, caller, run.runId)
        const op: Op = { childRunId: child.runId, rpcId: msg.id, callId: msg.params.callId, state: 'queued', t: { received: Date.now(), dispatched: 0, answered: 0 } }
        run.ops.push(op)
        log($, { ev: 'delegate.prepared', runId: run.runId, childRunId: child.runId, recordedCaller: caller, actualCaller: agentId, callId: op.callId })
        return { kind: 'delegate', op }
      }
      if (msg.method === 'item/completed' && msg.params.item?.type === 'agentMessage') run.codexAnswer = msg.params.item.text
      if (msg.method === 'item/completed' && ['collabAgentToolCall', 'subAgentActivity'].includes(msg.params.item?.type)) {
        log($, { ev: 'tripwire', runId: run.runId, item: msg.params.item })
      }
      if (msg.method === 'turn/completed') {
        run.turnStatus = msg.params.turn?.status
        run.state = 'codex-done'
        run.t.codexDone = Date.now()
        log($, { ev: 'codex.done', runId: run.runId, status: run.turnStatus, answer: run.codexAnswer, usage: msg.params.turn?.usage ?? null })
        return { kind: 'done' }
      }
    }
    run.cursor = page.cursor
  }
  return { kind: 'deadline' }
}

const dispatch = (e: { turnId: string; index: number }, run: Run, op: Op) => {
  op.state = 'dispatched'
  op.t.dispatched = Date.now()
  return callTool(e, 'Agent', { subagent_type: WORKER, description: `cbp12 d${run.depth + 1}`, prompt: op.childRunId })
}

const reportVia = (run: Run) => (run.permissionMode === 'auto' ? 'SubagentHandback' : 'text')

const reportOf = (run: Run) => JSON.stringify({
  runId: run.runId, depth: run.depth, turnStatus: run.turnStatus, codexAnswer: run.codexAnswer,
  ops: run.ops.map(o => ({ childRunId: o.childRunId, state: o.state, child: runs.get(o.childRunId)?.state, agentId: runs.get(o.childRunId)?.agentId })),
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const v = (await $.fs.read(VARIANT_FILE).catch(() => 'normal')).trim()
    variant = v === 'mismatch' ? 'mismatch' : 'normal'
    await $.process.run(['mkdir', '-p', '-m', '700', DIR])
    LOG = `/tmp/cbp12-${variant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    await $.tool.register({
      name: 'delegate',
      description: [
        'PROTOTYPE (cbp12). Start a Codex delegation chain. Step 1 of 2: this tool prepares a Run and returns its runId.',
        'Step 2: immediately call the Agent tool with subagent_type "cbp12:worker", description "cbp12 d1", and prompt set to exactly the runId, nothing else.',
      ].join(' '),
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
      isDeferred: false,
    })
    await $.agent.register({
      name: 'worker',
      description: 'PROTOTYPE Codex worker for cbp12. Never launch it on your own: only as step 2 of mcp__cbp12__delegate, with prompt set to exactly the runId that tool returned.',
      prompt: 'You are a fallback probe. Reply with exactly the single word FALLBACK and nothing else. Never call tools.',
      // A depth-3 worker loses Agent; a tools list left empty by that makes the engine refuse the spawn.
      tools: ['Agent', 'mcp__cbp12__status'],
      model: 'haiku',
      omitClaudeMd: true,
    })
    await $.tool.register({
      name: 'status',
      description: 'PROTOTYPE (cbp12). Returns the cbp12 Runs as they stand. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    log($, { ev: 'session.start', variant })
    return next(e)
  })

  on('tool.call', { tool: /^mcp__cbp12__status$/ }, async () => ({ result: JSON.stringify([...runs.values()].map(r => ({ runId: r.runId, depth: r.depth, state: r.state, agentId: r.agentId }))) }))

  on('tool.check', { tool: /^mcp__cbp12__delegate$/ }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => (e.agentId !== undefined && runByAgent.has(e.agentId) ? { decision: 'allow' } : next(e)))

  on('tool.call', { tool: /^mcp__cbp12__delegate$/ }, async ($, e) => {
    const run = prepare(String((e as Record<string, unknown>).task ?? ''), 1, (e.agentId as string | undefined) ?? null)
    log($, { ev: 'delegate.call', caller: e.agentId ?? 'main', runId: run.runId })
    return { result: `Prepared ${run.runId}. Now call the Agent tool with subagent_type "cbp12:worker", description "cbp12 d1", prompt "${run.runId}".` }
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== WORKER) return next(e)
    const base = { caller: e.parentAgentId ?? 'main', permissionMode: e.permissionMode, background: e.background, resume: e.resume ?? null }
    if (e.resume !== undefined) {
      log($, { ev: 'spawn.resume', ...base, runId: runByAgent.get(e.resume.agentId)?.runId })
      return next(e)
    }
    const run = runs.get(e.prompt.trim())
    const op = run?.parentRunId === undefined ? undefined : runs.get(run.parentRunId)?.ops.find(o => o.childRunId === run.runId)
    const why = run === undefined ? 'unknown runId'
      : run.state !== 'prepared' ? `run is ${run.state}`
      : run.callerAgentId !== (e.parentAgentId ?? null) ? `caller mismatch (recorded ${run.callerAgentId}, actual ${e.parentAgentId ?? 'main'})`
      : undefined
    if (why !== undefined || run === undefined) {
      log($, { ev: 'spawn.deny', reason: why, ...base, prompt: e.prompt.slice(0, 200) })
      if (run !== undefined && op !== undefined && op.state === 'dispatched') {
        run.state = 'failed'
        await answerCodex($, op, false, `bridge_delegate refused: ${why}`)
        log($, { ev: 'codex.answered', runId: run.parentRunId, childRunId: run.runId, success: false, heldMs: op.t.answered - op.t.received })
      }
      return { deny: `cbp12:worker refused (${why}).` }
    }
    run.state = 'binding'
    run.permissionMode = e.permissionMode
    run.t.spawnHook = Date.now()
    const r = await next({ ...e, prompt: run.runId })
    run.t.spawnResolved = Date.now()
    if (r.deny !== undefined || r.agentId === undefined) {
      run.state = 'failed'
      log($, { ev: 'spawn.denied-by-core', runId: run.runId, deny: r.deny, ...base })
      if (op !== undefined) await answerCodex($, op, false, `bridge_delegate refused by host: ${r.deny}`)
      return r
    }
    run.agentId = r.agentId
    runByAgent.set(r.agentId, run)
    run.state = 'bound'
    const listed = (await $.agent.list()).find(a => a.id === r.agentId)
    log($, { ev: 'spawn.bound', runId: run.runId, depth: run.depth, agentId: r.agentId, ...base, listedParentId: (listed as any)?.parentId ?? null, ms: run.t.spawnResolved - run.t.spawnHook })
    if (op !== undefined) {
      await answerCodex($, op, true, JSON.stringify({ runId: run.runId, state: 'accepted' }))
      log($, { ev: 'codex.answered', runId: run.parentRunId, childRunId: run.runId, success: true, heldMs: op.t.answered - op.t.received, dispatchToBindMs: run.t.spawnResolved - op.t.dispatched })
    }
    return r
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.subagent_type !== WORKER) return next(e)
    const t0 = Date.now()
    const r = await next(e)
    log($, { ev: 'agent.result', caller: e.agentId ?? 'main', prompt: String(e.prompt).slice(0, 100), elapsedMs: Date.now() - t0, result: r })
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    const run = runByAgent.get(id)
    if (run === undefined) {
      const info = (await $.agent.list()).find(a => a.id === id)
      if (!info?.description.startsWith('cbp12')) return yield* next(e)
      log($, { ev: 'step.unbound', agentId: id, index: e.index })
      return yield* answerText(e, 'cbp12: no Run for this worker; refusing to run')
    }
    const n = (steps.get(id) ?? 0) + 1
    steps.set(id, n)
    log($, { ev: 'step.seen', agentId: id, runId: run.runId, depth: run.depth, index: e.index, n, state: run.state, ops: run.ops.map(o => o.state), budgetMs: next.budget.remainingMs })
    if (n > STEP_CAP) return yield* answerText(e, `cbp12: step cap ${STEP_CAP} reached`)

    // A dispatched spawn that never reached agent.spawn (the host refused the Agent call) fails here.
    for (const op of run.ops.filter(o => o.state === 'dispatched')) {
      const child = runs.get(op.childRunId)
      if (child?.state !== 'prepared') continue
      child.state = 'failed'
      await answerCodex($, op, false, 'bridge_delegate failed: the host did not start the agent')
      log($, { ev: 'codex.answered', runId: run.runId, childRunId: op.childRunId, success: false, reason: 'no agent.spawn after dispatch', heldMs: op.t.answered - op.t.received })
    }
    const queued = run.ops.find(o => o.state === 'queued')
    if (queued !== undefined) return yield* dispatch(e, run, queued)

    if (run.state === 'bound') await activate($, run)
    if (run.state === 'active') {
      const polled = await pollCodex($, run, id, () => next.budget.remainingMs)
      if (polled.kind === 'delegate') return yield* dispatch(e, run, polled.op)
      if (polled.kind === 'deadline') return yield* answerText(e, `cbp12 ${run.runId}: still waiting for Codex`)
    }
    if (run.state === 'codex-done') {
      // The host notifies the caller only when a worker stops with no live children, so the report waits for them.
      const live = run.ops.map(o => runs.get(o.childRunId)).filter(c => c !== undefined && !TERMINAL.includes(c.state))
      if (live.length > 0) {
        log($, { ev: 'wait.children', runId: run.runId, live: live.map(c => `${c!.runId}:${c!.state}`) })
        return yield* answerText(e, `cbp12 ${run.runId}: waiting for ${live.length} child run(s)`)
      }
      run.state = 'reported'
      run.t.reported = Date.now()
      const message = `cbp12 report ${reportOf(run)}`
      log($, { ev: 'report', runId: run.runId, via: reportVia(run), message })
      if (reportVia(run) === 'SubagentHandback') return yield* callTool(e, 'SubagentHandback', { message })
      return yield* answerText(e, message)
    }
    return yield* answerText(e, `cbp12 ${run.runId}: already reported`)
  }).catch(async function* ($, e, next) {
    log($, { ev: 'step.caught', agentId: e.agentId, index: e.index, error: String(next.error?.message ?? next.error) })
    return yield* answerText(e, `cbp12 error: ${next.error.message}`)
  })

  on('turn.complete', async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runByAgent.get(e.agentId)
    if (run !== undefined) {
      if (e.reason === 'error' && !TERMINAL.includes(run.state)) run.state = 'failed'
      log($, { ev: 'turn.complete', agentId: e.agentId, runId: run.runId, reason: e.reason, answer: e.answer, usage: e.usage ?? null, runState: run.state })
    }
    return next(e)
  })
}

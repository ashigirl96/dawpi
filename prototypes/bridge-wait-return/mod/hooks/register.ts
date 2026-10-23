// PROTOTYPE (dawpi #13): throwaway. Answers whether a child Run's result can reach
// the parent's Codex only through the answer to its held `bridge_wait` call
// (main → A → B), while B's report lands in A's conversation and nowhere else;
// and how the host treats B's report when A is still inside a Host Step.
import type { Register, EngineInterface, TurnStepResult } from 'claude-code'

const DIR = '/tmp/cbp13'
const SOCKET = `${DIR}/r.sock`
const WORK = '/tmp/cbp13-work'
const VARIANT_FILE = '/tmp/cbp13-variant'
const WORKER = 'cbp13:worker'
const MODEL = 'gpt-5.6-luna'
const LEAF_DEPTH = 2
const STEP_CAP = 30
const POLL_MS = 8000
const HELD_POLL_MS = 2000
const STEP_DEADLINE_MS = 300_000

// hold: while bridge_wait is held, A's worker stays inside its Host Step reading Codex.
// hold-probe: as hold, then one harmless tool call before the report, to get one more Host Step in the same turn.
// yield: A's worker ends its turn with text and is woken by B's report.
type Variant = 'hold' | 'hold-probe' | 'yield'
const VARIANTS: readonly Variant[] = ['hold', 'hold-probe', 'yield']

type OpState = 'queued' | 'dispatched' | 'answered' | 'failed'
type Op = { childRunId: string; rpcId: number; callId: string; state: OpState; t: { received: number; dispatched: number; answered: number } }
type Wait = { childRunId: string; rpcId: number; callId: string; state: 'held' | 'answered' | 'failed'; t: { received: number; answered: number } }

type RunState = 'prepared' | 'binding' | 'bound' | 'active' | 'codex-done' | 'reported' | 'failed'
type Run = {
  runId: string
  depth: number
  task: string
  nonce: string
  state: RunState
  // The worker's turn has ended after reaching a terminal state; only then does the host count it as not live.
  stopped: boolean
  callerAgentId: string | null
  agentId?: string
  parentRunId?: string
  permissionMode?: string
  threadId?: string
  cursor: number
  ops: Op[]
  waits: Wait[]
  probed: boolean
  codexAnswer?: string
  turnStatus?: string
  t: Record<string, number>
}

const TERMINAL: readonly RunState[] = ['reported', 'failed']

const runs = new Map<string, Run>()
const runByAgent = new Map<string, Run>()
const steps = new Map<string, number>()

let variant: Variant = 'hold'
let LOG = `${DIR}/log.json`
const entries: unknown[] = []
let flushing = Promise.resolve()
const log = ($: EngineInterface, entry: Record<string, unknown>) => {
  entries.push({ t: Date.now(), ...entry })
  const snapshot = JSON.stringify(entries, null, 2)
  flushing = flushing.then(() => $.fs.write(LOG, snapshot)).catch(() => undefined)
}

const rand = () => Math.random().toString(36).slice(2, 10)
const toolUseId = () => `toolu_cbp13${rand()}`

const prepare = (task: string, depth: number, callerAgentId: string | null, parentRunId?: string): Run => {
  const run: Run = {
    runId: `run_${rand()}`, depth, task, nonce: rand(), state: 'prepared', stopped: false, callerAgentId, parentRunId,
    cursor: 0, ops: [], waits: [], probed: false, t: { prepared: Date.now() },
  }
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
  description: 'Delegate a sub-task to another Codex agent managed by the Bridge. Returns {runId, state} right away; it does not wait for the sub-task to finish.',
  inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
}

const BRIDGE_WAIT = {
  type: 'function',
  name: 'bridge_wait',
  description: 'Wait until a sub-task started with bridge_delegate has finished, and return its result. Blocks until then.',
  inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
}

const codexPrompt = (run: Run) => run.depth >= LEAF_DEPTH
  ? `Reply with exactly this text and nothing else: B-RESULT ${run.nonce}. Do not run any tool.`
  : [
    'You are the parent in a delegation test.',
    `First call bridge_delegate exactly once with {"task":"level ${run.depth + 1}"}.`,
    'Then call bridge_wait exactly once with the runId it returned.',
    'Then reply with only the exact text that bridge_wait returned, nothing else. Do not run any other tool.',
  ].join(' ')

const activate = async ($: EngineInterface, run: Run) => {
  await ensureRelay($)
  const thread = await rpc($, '/call', {
    method: 'thread/start',
    params: {
      model: MODEL, ephemeral: true, cwd: WORK, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user',
      dynamicTools: run.depth >= LEAF_DEPTH ? [] : [BRIDGE_DELEGATE, BRIDGE_WAIT],
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
  log($, { ev: 'activate', runId: run.runId, depth: run.depth, threadId: run.threadId, nonce: run.nonce, turn: turn.result?.turn?.id ?? turn })
}

const toCodex = async ($: EngineInterface, rpcId: number, success: boolean, text: string) => {
  const sent = { id: rpcId, result: { contentItems: [{ type: 'inputText', text }], success } }
  await rpc($, '/send', sent)
  return sent
}

const answerCodex = async ($: EngineInterface, op: Op, success: boolean, text: string) => {
  await toCodex($, op.rpcId, success, text)
  op.t.answered = Date.now()
  op.state = success ? 'answered' : 'failed'
}

// Every message the Mod sends into a Codex thread goes through here or answerCodex,
// so the log of `to.codex` entries is the complete list of what A's Codex was told.
const answerReadyWaits = async ($: EngineInterface, run: Run, where: string) => {
  for (const w of run.waits.filter(x => x.state === 'held')) {
    const child = runs.get(w.childRunId)
    if (child === undefined || !TERMINAL.includes(child.state) || !child.stopped) continue
    const success = child.state === 'reported'
    const text = JSON.stringify({ runId: child.runId, state: child.state, result: child.codexAnswer ?? null })
    const sent = await toCodex($, w.rpcId, success, text)
    w.state = success ? 'answered' : 'failed'
    w.t.answered = Date.now()
    log($, { ev: 'to.codex', kind: 'bridge_wait', runId: run.runId, childRunId: child.runId, where, heldMs: w.t.answered - w.t.received, sinceChildStoppedMs: w.t.answered - child.t.stopped, sent })
  }
}

const heldLive = (run: Run) => run.waits.some(w => w.state === 'held')

type Polled = { kind: 'delegate'; op: Op } | { kind: 'held' } | { kind: 'done' } | { kind: 'deadline' }

// Reads this Run's Codex events from its own cursor; a delegate request stops
// the read right after itself, so the Host Step can hand the spawn back to the host.
const pollCodex = async ($: EngineInterface, run: Run, agentId: string, budget: () => number): Promise<Polled> => {
  const t0 = Date.now()
  while (Date.now() - t0 < STEP_DEADLINE_MS) {
    await answerReadyWaits($, run, 'poll')
    const page = await rpc($, `/events?after=${run.cursor}&waitMs=${heldLive(run) ? HELD_POLL_MS : POLL_MS}`)
    if (page.events.length > 0 || !heldLive(run)) {
      log($, { ev: 'poll', runId: run.runId, cursor: run.cursor, waitedMs: page.waitedMs, got: page.events.length, budgetMs: budget() })
    }
    for (const { seq, msg } of page.events) {
      run.cursor = seq
      if (msg.params?.threadId !== run.threadId) continue
      if (msg.method === 'item/tool/call') {
        log($, { ev: 'codex.request', runId: run.runId, msg })
        const tool = msg.params.tool
        if (tool === 'bridge_wait') {
          const childRunId = String(msg.params.arguments?.runId ?? '')
          if (!run.ops.some(o => o.childRunId === childRunId)) {
            log($, { ev: 'to.codex', kind: 'bridge_wait', runId: run.runId, sent: await toCodex($, msg.id, false, `bridge_wait: ${childRunId} is not a child of this run`) })
            continue
          }
          run.waits.push({ childRunId, rpcId: msg.id, callId: msg.params.callId, state: 'held', t: { received: Date.now(), answered: 0 } })
          log($, { ev: 'wait.held', runId: run.runId, childRunId, child: runs.get(childRunId)?.state, variant })
          await answerReadyWaits($, run, 'on-request')
          if (variant === 'yield' && heldLive(run)) return { kind: 'held' }
          continue
        }
        if (tool !== 'bridge_delegate') {
          log($, { ev: 'to.codex', kind: tool, runId: run.runId, sent: await toCodex($, msg.id, false, 'unknown tool') })
          continue
        }
        const child = prepare(String(msg.params.arguments?.task ?? ''), run.depth + 1, agentId, run.runId)
        const op: Op = { childRunId: child.runId, rpcId: msg.id, callId: msg.params.callId, state: 'queued', t: { received: Date.now(), dispatched: 0, answered: 0 } }
        run.ops.push(op)
        log($, { ev: 'delegate.prepared', runId: run.runId, childRunId: child.runId, callId: op.callId })
        return { kind: 'delegate', op }
      }
      if (msg.method === 'item/completed' && msg.params.item?.type === 'agentMessage') run.codexAnswer = msg.params.item.text
      if (msg.method === 'item/completed') {
        const item = msg.params.item
        log($, { ev: 'codex.item', runId: run.runId, type: item?.type, item: item?.type === 'dynamicToolCall' ? item : JSON.stringify(item).slice(0, 600) })
      }
      if (msg.method === 'turn/completed') {
        run.turnStatus = msg.params.turn?.status
        run.state = 'codex-done'
        run.t.codexDone = Date.now()
        const nonces = run.ops.map(o => runs.get(o.childRunId)?.nonce).filter(Boolean)
        log($, { ev: 'codex.done', runId: run.runId, status: run.turnStatus, answer: run.codexAnswer, childNonceInAnswer: nonces.map(n => run.codexAnswer?.includes(n!) ?? false) })
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
  return callTool(e, 'Agent', { subagent_type: WORKER, description: `cbp13 d${run.depth + 1}`, prompt: op.childRunId })
}

const reportVia = (run: Run) => (run.permissionMode === 'auto' ? 'SubagentHandback' : 'text')

const reportOf = (run: Run) => JSON.stringify({
  runId: run.runId, depth: run.depth, turnStatus: run.turnStatus, codexAnswer: run.codexAnswer,
  ops: run.ops.map(o => ({ childRunId: o.childRunId, state: o.state, child: runs.get(o.childRunId)?.state })),
  waits: run.waits.map(w => ({ childRunId: w.childRunId, state: w.state })),
})

// Where the child's report sits in this worker's own conversation, as the next request carries it.
const conversationProbe = async ($: EngineInterface, agentId: string) => {
  const api = (await $.session.messages({ agentId, as: 'api' } as any)) as any
  if (api === null || typeof api !== 'object' || 'deny' in api) return { deny: api?.deny ?? String(api) }
  const messages: any[] = Array.isArray(api) ? api : (api.messages ?? [])
  const hits = messages
    .map((m, i) => ({ i, role: m.role, text: JSON.stringify(m.content) }))
    .filter(m => m.text.includes('cbp13 report') || m.text.includes('agent-message') || m.text.includes('task-notification'))
    .map(m => ({ i: m.i, role: m.role, excerpt: m.text.slice(0, 400) }))
  return { count: messages.length, hits }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const v = (await $.fs.read(VARIANT_FILE).catch(() => 'hold')).trim()
    variant = VARIANTS.find(x => x === v) ?? 'hold'
    await $.process.run(['mkdir', '-p', '-m', '700', DIR])
    LOG = `/tmp/cbp13-${variant}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    await $.tool.register({
      name: 'delegate',
      description: [
        'PROTOTYPE (cbp13). Start a Codex delegation chain. Step 1 of 2: this tool prepares a Run and returns its runId.',
        'Step 2: immediately call the Agent tool with subagent_type "cbp13:worker", description "cbp13 d1", and prompt set to exactly the runId, nothing else.',
      ].join(' '),
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
      isDeferred: false,
    })
    await $.agent.register({
      name: 'worker',
      description: 'PROTOTYPE Codex worker for cbp13. Never launch it on your own: only as step 2 of mcp__cbp13__delegate, with prompt set to exactly the runId that tool returned.',
      prompt: 'You are a fallback probe. Reply with exactly the single word FALLBACK and nothing else. Never call tools.',
      tools: ['Agent', 'mcp__cbp13__status'],
      model: 'haiku',
      omitClaudeMd: true,
    })
    await $.tool.register({
      name: 'status',
      description: 'PROTOTYPE (cbp13). Returns the cbp13 Runs as they stand. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    log($, { ev: 'session.start', variant })
    return next(e)
  })

  on('tool.call', { tool: /^mcp__cbp13__status$/ }, async () => ({ result: JSON.stringify([...runs.values()].map(r => ({ runId: r.runId, depth: r.depth, state: r.state, stopped: r.stopped, agentId: r.agentId }))) }))

  on('tool.check', { tool: /^mcp__cbp13__(delegate|status)$/ }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => (e.agentId !== undefined && runByAgent.has(e.agentId) ? { decision: 'allow' } : next(e)))

  on('tool.call', { tool: /^mcp__cbp13__delegate$/ }, async ($, e) => {
    const run = prepare(String((e as Record<string, unknown>).task ?? ''), 1, (e.agentId as string | undefined) ?? null)
    log($, { ev: 'delegate.call', caller: e.agentId ?? 'main', runId: run.runId })
    return { result: `Prepared ${run.runId}. Now call the Agent tool with subagent_type "cbp13:worker", description "cbp13 d1", prompt "${run.runId}".` }
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== WORKER) return next(e)
    const base = { caller: e.parentAgentId ?? 'main', permissionMode: e.permissionMode, background: e.background, resume: e.resume ?? null }
    if (e.resume !== undefined) {
      const run = runByAgent.get(e.resume.agentId)
      log($, { ev: 'spawn.resume', ...base, runId: run?.runId, runState: run?.state, waits: run?.waits.map(w => w.state) })
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
        run.stopped = true
        await answerCodex($, op, false, `bridge_delegate refused: ${why}`)
      }
      return { deny: `cbp13:worker refused (${why}).` }
    }
    run.state = 'binding'
    run.permissionMode = e.permissionMode
    run.t.spawnHook = Date.now()
    const r = await next({ ...e, prompt: run.runId })
    run.t.spawnResolved = Date.now()
    if (r.deny !== undefined || r.agentId === undefined) {
      run.state = 'failed'
      run.stopped = true
      log($, { ev: 'spawn.denied-by-core', runId: run.runId, deny: r.deny, ...base })
      if (op !== undefined) await answerCodex($, op, false, `bridge_delegate refused by host: ${r.deny}`)
      return r
    }
    run.agentId = r.agentId
    runByAgent.set(r.agentId, run)
    run.state = 'bound'
    log($, { ev: 'spawn.bound', runId: run.runId, depth: run.depth, agentId: r.agentId, ...base })
    if (op !== undefined) {
      await answerCodex($, op, true, JSON.stringify({ runId: run.runId, state: 'accepted' }))
      log($, { ev: 'to.codex', kind: 'bridge_delegate', runId: run.parentRunId, childRunId: run.runId, heldMs: op.t.answered - op.t.received })
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
      if (!info?.description.startsWith('cbp13')) return yield* next(e)
      log($, { ev: 'step.unbound', agentId: id, index: e.index })
      return yield* answerText(e, 'cbp13: no Run for this worker; refusing to run')
    }
    const n = (steps.get(id) ?? 0) + 1
    steps.set(id, n)
    const convo = run.depth < LEAF_DEPTH ? await conversationProbe($, id) : undefined
    log($, { ev: 'step.seen', agentId: id, runId: run.runId, depth: run.depth, index: e.index, n, messageCount: e.messageCount, state: run.state, ops: run.ops.map(o => o.state), waits: run.waits.map(w => w.state), convo, budgetMs: next.budget.remainingMs })
    if (n > STEP_CAP) return yield* answerText(e, `cbp13: step cap ${STEP_CAP} reached`)

    for (const op of run.ops.filter(o => o.state === 'dispatched')) {
      const child = runs.get(op.childRunId)
      if (child?.state !== 'prepared') continue
      child.state = 'failed'
      child.stopped = true
      await answerCodex($, op, false, 'bridge_delegate failed: the host did not start the agent')
    }
    const queued = run.ops.find(o => o.state === 'queued')
    if (queued !== undefined) return yield* dispatch(e, run, queued)

    await answerReadyWaits($, run, `step ${e.index}`)
    if (run.state === 'bound') await activate($, run)
    if (run.state === 'active') {
      const polled = await pollCodex($, run, id, () => next.budget.remainingMs)
      if (polled.kind === 'delegate') return yield* dispatch(e, run, polled.op)
      if (polled.kind === 'held') return yield* answerText(e, `cbp13 ${run.runId}: Codex is waiting on a child run`)
      if (polled.kind === 'deadline') return yield* answerText(e, `cbp13 ${run.runId}: still waiting for Codex`)
    }
    if (run.state === 'codex-done') {
      // The host notifies the caller only when a worker stops with no live children, so the report waits for them.
      const live = run.ops.map(o => runs.get(o.childRunId)).filter(c => c !== undefined && !c.stopped)
      if (live.length > 0) {
        log($, { ev: 'wait.children', runId: run.runId, live: live.map(c => `${c!.runId}:${c!.state}`) })
        return yield* answerText(e, `cbp13 ${run.runId}: waiting for ${live.length} child run(s)`)
      }
      if (variant === 'hold-probe' && !run.probed) {
        run.probed = true
        log($, { ev: 'probe.step', runId: run.runId })
        return yield* callTool(e, 'mcp__cbp13__status', {})
      }
      run.state = 'reported'
      run.t.reported = Date.now()
      const message = `cbp13 report ${reportOf(run)}`
      log($, { ev: 'report', runId: run.runId, via: reportVia(run), message })
      if (reportVia(run) === 'SubagentHandback') return yield* callTool(e, 'SubagentHandback', { message })
      return yield* answerText(e, message)
    }
    return yield* answerText(e, `cbp13 ${run.runId}: already reported`)
  }).catch(async function* ($, e, next) {
    log($, { ev: 'step.caught', agentId: e.agentId, index: e.index, error: String(next.error?.message ?? next.error) })
    return yield* answerText(e, `cbp13 error: ${next.error.message}`)
  })

  on('turn.complete', async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runByAgent.get(e.agentId)
    if (run !== undefined) {
      if (e.reason === 'error' && !TERMINAL.includes(run.state)) run.state = 'failed'
      if (TERMINAL.includes(run.state) && !run.stopped) {
        run.stopped = true
        run.t.stopped = Date.now()
      }
      log($, { ev: 'turn.complete', agentId: e.agentId, runId: run.runId, reason: e.reason, answer: e.answer, usage: e.usage ?? null, runState: run.state, stopped: run.stopped })
    }
    return next(e)
  })
}

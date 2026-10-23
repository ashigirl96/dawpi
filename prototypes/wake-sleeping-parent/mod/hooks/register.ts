// PROTOTYPE (dawpi #14): throwaway. Answers whether a parent worker that ended its
// turn while its Codex holds `bridge_wait` (it yields) can be woken by the Mod with
// `$.session.send` when that Codex asks for a new `bridge_delegate`, and whether the
// woken Host Step can still spawn the child with an `Agent` tool chunk and bind it.
import type { Register, EngineInterface, TurnStepResult } from 'claude-code'

const DIR = '/tmp/cbp14'
const SOCKET = `${DIR}/r.sock`
const WORK = '/tmp/cbp14-work'
const VARIANT_FILE = '/tmp/cbp14-variant'
const WORKER = 'cbp14:worker'
const MODEL = 'gpt-5.6-luna'
const LEAF_DEPTH = 2
const STEP_CAP = 30
const POLL_MS = 8000
const SETTLE_MS = 300
const WATCH_MS = 500
const STEP_DEADLINE_MS = 300_000
const SLOW_CHILD_S = 20
const PROBE_CAP = 5

// The variant file holds `<scenario>-<waker>`.
// pending: Codex A waits on the slow child with a short timeout, gets `pending`, then delegates again.
// parallel: Codex A delegates again while its first bridge_wait is still held.
type Scenario = 'pending' | 'parallel'
const SCENARIOS: readonly Scenario[] = ['pending', 'parallel']
// send: the Mod wakes the worker with `$.session.send`.
// bell: before sleeping the worker starts a background Bash that blocks on a FIFO; the Mod writes the FIFO to end it,
//   and the host wakes the worker with that task's notification.
// refuse: a bridge_delegate that arrives while the worker sleeps is refused instead of waking it.
type Waker = 'send' | 'bell' | 'refuse'
const WAKERS: readonly Waker[] = ['send', 'bell', 'refuse']
type Bell = 'none' | 'starting' | 'live' | 'rung'

type OpState = 'queued' | 'dispatched' | 'answered' | 'failed'
type Op = { childRunId: string; rpcId: number; callId: string; state: OpState; whileAsleep: boolean; t: { received: number; dispatched: number; answered: number } }
type Wait = { childRunId: string; rpcId: number; callId: string; state: 'held' | 'answered' | 'pending' | 'failed'; deadline: number | null; t: { received: number; answered: number } }

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
  // While the worker sleeps, a watch outside any Host Step reads its Codex; only one reader owns the cursor.
  asleep: boolean
  watch?: Promise<void>
  wakes: { at: number; reason: string; sent: unknown }[]
  bell: Bell
  bellSeq: number
  bellsRung: number
  probes: number
  codexAnswer?: string
  turnStatus?: string
  t: Record<string, number>
}

const TERMINAL: readonly RunState[] = ['reported', 'failed']

const runs = new Map<string, Run>()
const runByAgent = new Map<string, Run>()
const steps = new Map<string, number>()

let scenario: Scenario = 'pending'
let waker: Waker = 'send'
let LOG = `${DIR}/log.json`
const entries: unknown[] = []
let flushing = Promise.resolve()
const log = ($: EngineInterface, entry: Record<string, unknown>) => {
  entries.push({ t: Date.now(), ...entry })
  const snapshot = JSON.stringify(entries, null, 2)
  flushing = flushing.then(() => $.fs.write(LOG, snapshot)).catch(() => undefined)
}

const rand = () => Math.random().toString(36).slice(2, 10)
const toolUseId = () => `toolu_cbp14${rand()}`

const prepare = (task: string, depth: number, callerAgentId: string | null, parentRunId?: string): Run => {
  const run: Run = {
    runId: `run_${rand()}`, depth, task, nonce: rand(), state: 'prepared', stopped: false, callerAgentId, parentRunId,
    cursor: 0, ops: [], waits: [], asleep: false, wakes: [], bell: 'none', bellSeq: 0, bellsRung: 0, probes: 0, t: { prepared: Date.now() },
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
  description: 'Wait until a sub-task started with bridge_delegate has finished, and return its result. With timeoutMs, returns state "pending" if it has not finished by then.',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string' }, timeoutMs: { type: 'number' } },
    required: ['runId'], additionalProperties: false,
  },
}

const PARENT_PROMPTS: Record<Scenario, string[]> = {
  pending: [
    'You are the parent in a delegation test. Make one tool call at a time, in this order.',
    '1) Call bridge_delegate with {"task":"level 2 slow"}.',
    '2) Call bridge_wait with {"runId": <the runId from step 1>, "timeoutMs": 3000}. It will return state pending; that is expected.',
    '3) Call bridge_delegate with {"task":"level 2 fast"}.',
    '4) Call bridge_wait with the runId from step 3, without timeoutMs.',
    '5) Call bridge_wait with the runId from step 1, without timeoutMs.',
    '6) Reply with only the texts that steps 4 and 5 returned, one per line, nothing else. Do not run any other tool.',
  ],
  parallel: [
    'You are the parent in a delegation test.',
    '1) Call bridge_delegate with {"task":"level 2 slow"}.',
    '2) In one single code block, start bridge_wait with {"runId": <the runId from step 1>} without awaiting it, then await bridge_delegate with {"task":"level 2 fast"}, and only after that await the bridge_wait you started.',
    'bridge_wait blocks until the sub-task finishes, so the second bridge_delegate must be issued while it is still pending.',
    '3) Call bridge_wait with the runId from the second bridge_delegate.',
    '4) Reply with only the texts that the two bridge_wait calls returned, one per line, nothing else. Do not run any other tool.',
  ],
}

const codexPrompt = (run: Run) => run.depth >= LEAF_DEPTH
  ? `Reply with exactly this text and nothing else: CHILD-RESULT ${run.nonce}. Do not run any tool.`
  : PARENT_PROMPTS[scenario].join(' ')

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
  log($, { ev: 'activate', runId: run.runId, depth: run.depth, task: run.task, threadId: run.threadId, nonce: run.nonce, turn: turn.result?.turn?.id ?? turn })
}

// Every message the Mod sends into a Codex thread goes through here, so `to.codex` entries are the complete list.
const toCodex = async ($: EngineInterface, run: Run, kind: string, rpcId: number, success: boolean, text: string, extra: Record<string, unknown> = {}) => {
  const sent = { id: rpcId, result: { contentItems: [{ type: 'inputText', text }], success } }
  await rpc($, '/send', sent)
  log($, { ev: 'to.codex', kind, runId: run.runId, asleep: run.asleep, ...extra, sent })
  return sent
}

const answerOp = async ($: EngineInterface, run: Run, op: Op, success: boolean, text: string) => {
  await toCodex($, run, 'bridge_delegate', op.rpcId, success, text, { childRunId: op.childRunId, heldMs: Date.now() - op.t.received, whileAsleep: op.whileAsleep })
  op.t.answered = Date.now()
  op.state = success ? 'answered' : 'failed'
}

const answerReadyWaits = async ($: EngineInterface, run: Run, where: string) => {
  for (const w of run.waits.filter(x => x.state === 'held')) {
    const child = runs.get(w.childRunId)
    const done = child !== undefined && TERMINAL.includes(child.state) && child.stopped
    if (!done && (w.deadline === null || Date.now() < w.deadline)) continue
    const text = done
      ? JSON.stringify({ runId: child!.runId, state: child!.state, result: child!.codexAnswer ?? null })
      : JSON.stringify({ runId: w.childRunId, state: 'pending' })
    const success = !done || child!.state === 'reported'
    w.state = done ? (success ? 'answered' : 'failed') : 'pending'
    w.t.answered = Date.now()
    await toCodex($, run, 'bridge_wait', w.rpcId, success, text, {
      childRunId: w.childRunId, where, heldMs: w.t.answered - w.t.received, sinceChildStoppedMs: done ? w.t.answered - (child!.t.stopped ?? 0) : null,
    })
  }
}

const heldLive = (run: Run) => run.waits.some(w => w.state === 'held')

type Handled = { kind: 'delegate'; op: Op } | { kind: 'done' } | undefined

// One Codex event of this Run's thread; shared by the Host Step's read and the sleeping watch.
const handleEvent = async ($: EngineInterface, run: Run, agentId: string, msg: any): Promise<Handled> => {
  if (msg.params?.threadId !== run.threadId) return undefined
  if (msg.method === 'item/tool/call') {
    log($, { ev: 'codex.request', runId: run.runId, asleep: run.asleep, tool: msg.params.tool, arguments: msg.params.arguments, callId: msg.params.callId })
    const tool = msg.params.tool
    if (tool === 'bridge_wait') {
      const childRunId = String(msg.params.arguments?.runId ?? '')
      if (!run.ops.some(o => o.childRunId === childRunId)) {
        await toCodex($, run, 'bridge_wait', msg.id, false, `bridge_wait: ${childRunId} is not a child of this run`)
        return undefined
      }
      const timeoutMs = Number(msg.params.arguments?.timeoutMs)
      const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Date.now() + timeoutMs : null
      run.waits.push({ childRunId, rpcId: msg.id, callId: msg.params.callId, state: 'held', deadline, t: { received: Date.now(), answered: 0 } })
      log($, { ev: 'wait.held', runId: run.runId, childRunId, timeoutMs: deadline === null ? null : timeoutMs, child: runs.get(childRunId)?.state, asleep: run.asleep })
      await answerReadyWaits($, run, 'on-request')
      return undefined
    }
    if (tool !== 'bridge_delegate') {
      await toCodex($, run, tool, msg.id, false, 'unknown tool')
      return undefined
    }
    if (run.asleep && waker === 'refuse') {
      await toCodex($, run, 'bridge_delegate', msg.id, false,
        'bridge_delegate refused: this run is waiting on its sub-tasks. Start every sub-task with bridge_delegate before calling bridge_wait.')
      return undefined
    }
    const child = prepare(String(msg.params.arguments?.task ?? ''), run.depth + 1, agentId, run.runId)
    const op: Op = { childRunId: child.runId, rpcId: msg.id, callId: msg.params.callId, state: 'queued', whileAsleep: run.asleep, t: { received: Date.now(), dispatched: 0, answered: 0 } }
    run.ops.push(op)
    log($, { ev: 'delegate.prepared', runId: run.runId, childRunId: child.runId, task: child.task, callId: op.callId, whileAsleep: op.whileAsleep })
    return { kind: 'delegate', op }
  }
  if (msg.method === 'item/completed' && msg.params.item?.type === 'agentMessage') run.codexAnswer = msg.params.item.text
  if (msg.method === 'item/started' && run.depth < LEAF_DEPTH && !['userMessage', 'reasoning'].includes(msg.params.item?.type)) {
    log($, { ev: 'codex.item', runId: run.runId, asleep: run.asleep, item: JSON.stringify(msg.params.item).slice(0, 800) })
  }
  if (msg.method === 'turn/completed') {
    run.turnStatus = msg.params.turn?.status
    run.state = 'codex-done'
    run.t.codexDone = Date.now()
    const nonces = run.ops.map(o => runs.get(o.childRunId)?.nonce).filter(Boolean)
    log($, { ev: 'codex.done', runId: run.runId, status: run.turnStatus, answer: run.codexAnswer, childNonceInAnswer: nonces.map(n => run.codexAnswer?.includes(n!) ?? false) })
    return { kind: 'done' }
  }
  return undefined
}

type Polled = { kind: 'delegate'; op: Op } | { kind: 'held' } | { kind: 'done' } | { kind: 'deadline' }

// Reads this Run's Codex events from its own cursor; a delegate request stops
// the read right after itself, so the Host Step can hand the spawn back to the host.
const pollCodex = async ($: EngineInterface, run: Run, agentId: string): Promise<Polled> => {
  const t0 = Date.now()
  while (Date.now() - t0 < STEP_DEADLINE_MS) {
    await answerReadyWaits($, run, 'poll')
    const page = await rpc($, `/events?after=${run.cursor}&waitMs=${heldLive(run) ? SETTLE_MS : POLL_MS}`)
    for (const { seq, msg } of page.events) {
      run.cursor = seq
      const h = await handleEvent($, run, agentId, msg)
      if (h !== undefined) return h
    }
    run.cursor = page.cursor
    if (heldLive(run) && page.events.length === 0) return { kind: 'held' }
  }
  return { kind: 'deadline' }
}

const agentStatus = async ($: EngineInterface, agentId: string) => (await $.agent.list()).find(a => a.id === agentId)?.status

const bellPath = (run: Run) => `${DIR}/bell-${run.runId}-${run.bellSeq}`
const BELL_DESCRIPTION = 'cbp14 doorbell'

async function* startBell($: EngineInterface, e: { turnId: string; index: number }, run: Run): AsyncGenerator<any, TurnStepResult> {
  run.bellSeq++
  run.bell = 'starting'
  await $.process.run(['mkfifo', '-m', '600', bellPath(run)])
  log($, { ev: 'bell.start', runId: run.runId, path: bellPath(run) })
  return yield* callTool(e, 'Bash', { command: `cat ${bellPath(run)}`, description: BELL_DESCRIPTION, run_in_background: true })
}

// Opening the FIFO read-write never blocks, and closing it gives the doorbell's `cat` its EOF.
const ringBell = async ($: EngineInterface, run: Run) => {
  run.bell = 'rung'
  run.bellsRung++
  return $.process.run(['sh', '-c', `exec 3<>"${bellPath(run)}"; echo ring >&3`])
}

const wake = async ($: EngineInterface, run: Run, agentId: string, reason: string) => {
  const statusBefore = await agentStatus($, agentId)
  let sent: unknown
  try {
    sent = waker === 'bell'
      ? { bell: run.bell, rang: await ringBell($, run) }
      : await $.session.send({ to: { agentId }, text: `cbp14 wake ${run.runId}: ${reason}` })
  } catch (err) {
    sent = { threw: String(err) }
  }
  run.wakes.push({ at: Date.now(), reason, sent })
  log($, { ev: 'wake.send', runId: run.runId, agentId, reason, statusBefore, sent, statusAfter: await agentStatus($, agentId) })
}

// Runs outside any Host Step while the worker sleeps: answers timed-out waits and,
// when Codex needs a Host Step (a new delegate, or its turn ended), wakes the worker.
const watch = async ($: EngineInterface, run: Run, agentId: string) => {
  log($, { ev: 'watch.start', runId: run.runId, status: await agentStatus($, agentId) })
  try {
    while (run.asleep) {
      await answerReadyWaits($, run, 'watch')
      const page = await rpc($, `/events?after=${run.cursor}&waitMs=${WATCH_MS}`)
      let need: string | undefined
      for (const { seq, msg } of page.events) {
        if (!run.asleep) break
        run.cursor = seq
        const h = await handleEvent($, run, agentId, msg)
        if (h?.kind === 'delegate') need = `Codex asked for a new delegation (${h.op.childRunId})`
        if (h?.kind === 'done') need = 'Codex finished its turn'
        if (need !== undefined) break
      }
      if (need === undefined) {
        if (run.asleep) run.cursor = page.cursor
        continue
      }
      await wake($, run, agentId, need)
      return
    }
  } catch (err) {
    log($, { ev: 'watch.error', runId: run.runId, error: String(err) })
  } finally {
    log($, { ev: 'watch.end', runId: run.runId, asleep: run.asleep })
  }
}

const sleep = ($: EngineInterface, run: Run, agentId: string) => {
  run.asleep = true
  run.t.sleptAt = Date.now()
  run.watch = watch($, run, agentId)
}

const dispatch = (e: { turnId: string; index: number }, run: Run, op: Op) => {
  op.state = 'dispatched'
  op.t.dispatched = Date.now()
  return callTool(e, 'Agent', { subagent_type: WORKER, description: `cbp14 d${run.depth + 1}`, prompt: op.childRunId })
}

const reportVia = (run: Run) => (run.permissionMode === 'auto' ? 'SubagentHandback' : 'text')

const reportOf = (run: Run) => JSON.stringify({
  runId: run.runId, depth: run.depth, turnStatus: run.turnStatus, codexAnswer: run.codexAnswer,
  ops: run.ops.map(o => ({ childRunId: o.childRunId, state: o.state, whileAsleep: o.whileAsleep, child: runs.get(o.childRunId)?.state })),
  waits: run.waits.map(w => ({ childRunId: w.childRunId, state: w.state })),
  wakes: run.wakes.length,
})

// Where the children's notifications and the Mod's wake messages sit in this worker's own conversation.
const conversationProbe = async ($: EngineInterface, agentId: string, childAgentIds: string[]) => {
  const api = (await $.session.messages({ agentId, as: 'api' } as any)) as any
  if (api === null || typeof api !== 'object' || 'deny' in api) return { deny: api?.deny ?? String(api), notified: [] as string[], bellsNotified: 0 }
  const messages: any[] = Array.isArray(api) ? api : (api.messages ?? [])
  const texts = messages.map(m => JSON.stringify(m.content))
  const hits = texts
    .map((text, i) => ({ i, role: messages[i].role, text }))
    .filter(m => m.text.includes('cbp14 wake') || m.text.includes('agent-message') || m.text.includes('task-notification'))
    .map(m => ({ i: m.i, role: m.role, excerpt: m.text.slice(0, 400) }))
  const notified = childAgentIds.filter(c => texts.some(t => t.includes(`<task-id>${c}</task-id>`)))
  // The Bash call's own tool result mentions task notifications too, so only a completed doorbell's notification counts.
  const bellIds = new Set(texts.flatMap(t => [...t.matchAll(/<task-id>(\w+)<\/task-id>(?:(?!<\/task-notification>)[\s\S])*?Background command[^<]*cbp14 doorbell/g)].map(m => m[1])))
  const bellsNotified = bellIds.size
  return { count: messages.length, hits, notified, bellsNotified }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [s, w] = (await $.fs.read(VARIANT_FILE).catch(() => 'pending-send')).trim().split('-')
    scenario = SCENARIOS.find(x => x === s) ?? 'pending'
    waker = WAKERS.find(x => x === w) ?? 'send'
    await $.process.run(['mkdir', '-p', '-m', '700', DIR])
    LOG = `/tmp/cbp14-${scenario}-${waker}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    await $.tool.register({
      name: 'delegate',
      description: [
        'PROTOTYPE (cbp14). Start a Codex delegation chain. Step 1 of 2: this tool prepares a Run and returns its runId.',
        'Step 2: immediately call the Agent tool with subagent_type "cbp14:worker", description "cbp14 d1", and prompt set to exactly the runId, nothing else.',
      ].join(' '),
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
      isDeferred: false,
    })
    await $.agent.register({
      name: 'worker',
      description: 'PROTOTYPE Codex worker for cbp14. Never launch it on your own: only as step 2 of mcp__cbp14__delegate, with prompt set to exactly the runId that tool returned.',
      prompt: 'You are a fallback probe. Reply with exactly the single word FALLBACK and nothing else. Never call tools.',
      tools: ['Agent', 'Bash', 'mcp__cbp14__status'],
      model: 'haiku',
      omitClaudeMd: true,
    })
    await $.tool.register({
      name: 'status',
      description: 'PROTOTYPE (cbp14). Returns the cbp14 Runs as they stand. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    log($, { ev: 'session.start', scenario, waker })
    return next(e)
  })

  on('tool.call', { tool: /^mcp__cbp14__status$/ }, async () => ({
    result: JSON.stringify([...runs.values()].map(r => ({ runId: r.runId, depth: r.depth, state: r.state, stopped: r.stopped, bell: r.bell }))),
  }))

  on('tool.check', { tool: /^mcp__cbp14__(delegate|status)$/ }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => (e.agentId !== undefined && runByAgent.has(e.agentId) ? { decision: 'allow' } : next(e)))
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runByAgent.get(e.agentId)
    const command = String((e as Record<string, unknown>).command ?? '')
    return run !== undefined && command === `cat ${bellPath(run)}` ? { decision: 'allow' } : next(e)
  })

  on('tool.call', { tool: /^mcp__cbp14__delegate$/ }, async ($, e) => {
    const run = prepare(String((e as Record<string, unknown>).task ?? ''), 1, (e.agentId as string | undefined) ?? null)
    log($, { ev: 'delegate.call', caller: e.agentId ?? 'main', runId: run.runId })
    return { result: `Prepared ${run.runId}. Now call the Agent tool with subagent_type "cbp14:worker", description "cbp14 d1", prompt "${run.runId}".` }
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    log($, { ev: 'session.send', to: e.to, origin: e.origin, from: e.agentId ?? 'main', text: e.text.slice(0, 200), result: r })
    return r
  })

  on('session.receive', async ($, e, next) => {
    const r = await next(e)
    log($, { ev: 'session.receive', agentId: (e as any).agentId, origin: (e as any).origin, text: String((e as any).text).slice(0, 300), result: r })
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== WORKER) return next(e)
    const base = { caller: e.parentAgentId ?? 'main', permissionMode: e.permissionMode, background: e.background, resume: e.resume ?? null }
    if (e.resume !== undefined) {
      const run = runByAgent.get(e.resume.agentId)
      log($, { ev: 'spawn.resume', ...base, prompt: e.prompt.slice(0, 300), runId: run?.runId, runState: run?.state, asleep: run?.asleep, waits: run?.waits.map(w => w.state) })
      const r = await next(e)
      log($, { ev: 'spawn.resume.result', runId: run?.runId, result: r })
      return r
    }
    const run = runs.get(e.prompt.trim())
    const parent = run?.parentRunId === undefined ? undefined : runs.get(run.parentRunId)
    const op = parent?.ops.find(o => o.childRunId === run!.runId)
    const why = run === undefined ? 'unknown runId'
      : run.state !== 'prepared' ? `run is ${run.state}`
      : run.callerAgentId !== (e.parentAgentId ?? null) ? `caller mismatch (recorded ${run.callerAgentId}, actual ${e.parentAgentId ?? 'main'})`
      : undefined
    if (why !== undefined || run === undefined) {
      log($, { ev: 'spawn.deny', reason: why, ...base, prompt: e.prompt.slice(0, 200) })
      if (run !== undefined && parent !== undefined && op !== undefined && op.state === 'dispatched') {
        run.state = 'failed'
        run.stopped = true
        await answerOp($, parent, op, false, `bridge_delegate refused: ${why}`)
      }
      return { deny: `cbp14:worker refused (${why}).` }
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
      if (parent !== undefined && op !== undefined) await answerOp($, parent, op, false, `bridge_delegate refused by host: ${r.deny}`)
      return r
    }
    run.agentId = r.agentId
    runByAgent.set(r.agentId, run)
    run.state = 'bound'
    log($, { ev: 'spawn.bound', runId: run.runId, depth: run.depth, task: run.task, agentId: r.agentId, ...base })
    if (parent !== undefined && op !== undefined) await answerOp($, parent, op, true, JSON.stringify({ runId: run.runId, state: 'accepted' }))
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
      if (!info?.description.startsWith('cbp14')) return yield* next(e)
      log($, { ev: 'step.unbound', agentId: id, index: e.index })
      return yield* answerText(e, 'cbp14: no Run for this worker; refusing to run')
    }
    const n = (steps.get(id) ?? 0) + 1
    steps.set(id, n)
    const wasAsleep = run.asleep
    if (run.asleep) {
      run.asleep = false
      await run.watch
    }
    if (run.bell === 'starting') run.bell = 'live'
    const childAgentIds = run.ops.map(o => runs.get(o.childRunId)?.agentId).filter((x): x is string => x !== undefined)
    const convo = run.depth < LEAF_DEPTH ? await conversationProbe($, id, childAgentIds) : undefined
    log($, {
      ev: 'step.seen', agentId: id, runId: run.runId, depth: run.depth, index: e.index, n, messageCount: e.messageCount, wasAsleep,
      sleptMs: wasAsleep ? Date.now() - (run.t.sleptAt ?? 0) : null, bell: run.bell, state: run.state, ops: run.ops.map(o => o.state), waits: run.waits.map(w => w.state), convo,
    })
    if (n > STEP_CAP) return yield* answerText(e, `cbp14: step cap ${STEP_CAP} reached`)

    for (const op of run.ops.filter(o => o.state === 'dispatched')) {
      const child = runs.get(op.childRunId)
      if (child?.state !== 'prepared') continue
      child.state = 'failed'
      child.stopped = true
      await answerOp($, run, op, false, 'bridge_delegate failed: the host did not start the agent')
    }
    const queued = run.ops.find(o => o.state === 'queued')
    if (queued !== undefined) return yield* dispatch(e, run, queued)

    if (run.state === 'bound') {
      if (run.task.includes('slow') && run.t.slowed === undefined) {
        run.t.slowed = Date.now()
        await pause($, SLOW_CHILD_S)
      }
      await activate($, run)
    }
    if (run.state === 'active') {
      const polled = await pollCodex($, run, id)
      if (polled.kind === 'delegate') return yield* dispatch(e, run, polled.op)
      if (polled.kind === 'held') {
        if (waker === 'bell' && run.bell !== 'live') return yield* startBell($, e, run)
        sleep($, run, id)
        return yield* answerText(e, `cbp14 ${run.runId}: Codex is waiting on a child run`)
      }
      if (polled.kind === 'deadline') return yield* answerText(e, `cbp14 ${run.runId}: still waiting for Codex`)
    }
    if (run.state === 'codex-done') {
      // The host delivers a report only after the worker has taken in every child's completion notification.
      const children = run.ops.map(o => runs.get(o.childRunId)).filter(c => c !== undefined)
      const live = children.filter(c => !c!.stopped)
      const unnotified = children.filter(c => c!.agentId !== undefined && !(convo?.notified ?? []).includes(c!.agentId))
      // A live doorbell is a background task too, so it is rung and its notification awaited before the report.
      if (run.bell === 'live') await ringBell($, run)
      const bellsPending = run.bellSeq - (convo?.bellsNotified ?? 0)
      if (live.length > 0 || unnotified.length > 0) {
        log($, { ev: 'wait.children', runId: run.runId, live: live.map(c => `${c!.runId}:${c!.state}`), unnotified: unnotified.map(c => c!.runId), bellsPending })
        return yield* answerText(e, `cbp14 ${run.runId}: waiting for ${live.length} live child run(s), ${unnotified.length} notification(s)`)
      }
      // Stopping with only the doorbell live sends the caller an interim notification, so the worker takes
      // one more Host Step instead, at whose boundary the doorbell's notification comes in.
      if (bellsPending > 0) {
        run.probes++
        log($, { ev: 'wait.bell', runId: run.runId, bellsPending, probe: run.probes })
        if (run.probes <= PROBE_CAP) return yield* callTool(e, 'mcp__cbp14__status', {})
        return yield* answerText(e, `cbp14 ${run.runId}: waiting for ${bellsPending} doorbell(s)`)
      }
      run.state = 'reported'
      run.t.reported = Date.now()
      // A child whose parent is a Codex reports a receipt only; the result itself goes back through bridge_wait.
      const message = run.parentRunId === undefined ? `cbp14 report ${reportOf(run)}` : `cbp14 receipt ${run.runId}`
      log($, { ev: 'report', runId: run.runId, via: reportVia(run), message })
      if (reportVia(run) === 'SubagentHandback') return yield* callTool(e, 'SubagentHandback', { message })
      return yield* answerText(e, message)
    }
    return yield* answerText(e, `cbp14 ${run.runId}: already reported`)
  }).catch(async function* ($, e, next) {
    log($, { ev: 'step.caught', agentId: e.agentId, index: e.index, error: String(next.error?.message ?? next.error) })
    return yield* answerText(e, `cbp14 error: ${next.error.message}`)
  })

  on('turn.complete', async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runByAgent.get(e.agentId)
    if (run !== undefined) {
      if (e.reason === 'error' && !TERMINAL.includes(run.state)) run.state = 'failed'
      if (TERMINAL.includes(run.state) && !run.stopped) {
        run.stopped = true
        run.t.stopped = Date.now()
      }
      log($, { ev: 'turn.complete', agentId: e.agentId, runId: run.runId, reason: e.reason, answer: e.answer, usage: e.usage ?? null, runState: run.state, stopped: run.stopped, asleep: run.asleep })
    }
    return next(e)
  })
}

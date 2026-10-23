// PROTOTYPE (dawpi #4): throwaway. Answers whether a mod can hold a two-way
// JSON-RPC session with a long-lived `codex app-server`, and hand a Codex Turn's
// result back through a Host Step of an agent the mod registered.
import type { Register, EngineInterface, TurnStepResult } from 'claude-code'

const DIR = '/tmp/cbp4'
const LOG = `${DIR}/log.json`
const PROBE = 'mcp__cbp4__probe'
const WORKER = 'cbp4:worker'
const MODEL = 'gpt-5.6-luna'
const TURN_DEADLINE_MS = 180_000

type Mode = 'direct' | 'spawn' | 'detached'
const SOCKETS: Record<Mode, string> = {
  direct: `${DIR}/c.sock`,
  spawn: `${DIR}/s.sock`,
  detached: `${DIR}/d.sock`,
}

const entries: unknown[] = []
let flushing = Promise.resolve()
const log = ($: EngineInterface, entry: Record<string, unknown>) => {
  entries.push({ t: Date.now(), ...entry })
  const snapshot = JSON.stringify(entries, null, 2)
  flushing = flushing.then(() => $.fs.write(LOG, snapshot)).catch(() => undefined)
}

// `$.clock.sleep` bills the hook's budget; a `$.process.run` wait does not.
const pause = ($: EngineInterface, seconds: number) => $.process.run(['sleep', String(seconds)])

const rpc = async ($: EngineInterface, socketPath: string, path: string, body?: unknown) => {
  const res = await $.http.fetch(`http://relay${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    socketPath,
  })
  return JSON.parse(res.text)
}

const waitForRelay = async ($: EngineInterface, socketPath: string) => {
  for (let i = 0; i < 50; i++) {
    try {
      return await rpc($, socketPath, '/health')
    } catch (err) {
      if (i === 49) throw err
      await pause($, 0.2)
    }
  }
}

const relays = new Map<Mode, { health: unknown }>()

const startSpawned = async ($: EngineInterface) => {
  const socketPath = SOCKETS.spawn
  await $.process.run(['rm', '-f', socketPath])
  const relay = $.process.spawn({ argv: ['bun', `${$.plugin.root}/relay.ts`, socketPath] })
  void (async () => {
    for await (const { stream, text } of relay) log($, { ev: 'relay.output', mode: 'spawn', stream, text })
    log($, { ev: 'relay.loop.ended', mode: 'spawn' })
  })()
  return waitForRelay($, socketPath)
}

const startDetached = async ($: EngineInterface) => {
  const t0 = Date.now()
  const run = await $.process.run(
    ['sh', `${$.plugin.root}/bootstrap.sh`, SOCKETS.detached, `${DIR}/d.log`],
    { timeoutMs: 20_000 },
  )
  log($, { ev: 'bootstrap.run', elapsedMs: Date.now() - t0, run })
  return rpc($, SOCKETS.detached, '/health')
}

// The control case: the mod speaking to app-server's own Unix socket directly.
const probeDirect = async ($: EngineInterface) => {
  const socketPath = SOCKETS.direct
  await $.process.run(['rm', '-f', socketPath])
  const server = $.process.spawn({ argv: ['codex', 'app-server', '--listen', `unix://${socketPath}`] })
  const output: string[] = []
  const loop = (async () => {
    for await (const { text } of server) output.push(text)
  })()
  for (let i = 0; i < 25; i++) {
    if ((await $.process.run(['test', '-S', socketPath])).exitCode === 0) break
    await pause($, 0.2)
  }
  const t0 = Date.now()
  const attempt = $.http.fetch('http://codex/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cbp4', title: null, version: '0' }, capabilities: null } }),
    socketPath,
  }).then(
    r => ({ settledAfterMs: Date.now() - t0, status: r.status, ok: r.ok, headers: r.headers, text: r.text.slice(0, 500) }),
    (err: Error) => ({ settledAfterMs: Date.now() - t0, error: String(err?.message ?? err) }),
  )
  await pause($, 5)
  const before = await Promise.race([attempt, Promise.resolve('still pending after 5 s')])
  await (server as AsyncGenerator<unknown>).return?.(undefined)
  await loop.catch(() => undefined)
  const after = await attempt
  return { before, afterServerKilled: after, serverOutput: output.join('').slice(0, 1000) }
}

async function* answerText(e: { turnId: string; index: number }, text: string): AsyncGenerator<any, TurnStepResult> {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}

const modeOf = async ($: EngineInterface, agentId: string | undefined): Promise<Mode | undefined> => {
  if (agentId === undefined) return undefined
  const info = (await $.agent.list()).find(a => a.id === agentId)
  const m = info?.description.match(/^cbp4 (spawn|detached)$/)
  return m ? (m[1] as Mode) : undefined
}

// One Codex Turn through the relay: the dynamic tool call is a server request
// the mod must answer, which is the "two-way" half of the question.
const runCodexTurn = async ($: EngineInterface, mode: Mode, budget: () => number) => {
  const socketPath = SOCKETS[mode]
  const nonce = Math.random().toString(36).slice(2, 8)
  const thread = await rpc($, socketPath, '/call', {
    method: 'thread/start',
    params: {
      model: MODEL,
      ephemeral: true,
      cwd: DIR,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      dynamicTools: [{
        type: 'function',
        name: 'cbp4_echo',
        description: 'Returns a secret word. Call it when asked to.',
        inputSchema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
      }],
    },
  })
  log($, { ev: 'thread.start', mode, response: thread })
  const threadId = thread.result?.thread?.id
  if (!threadId) return { error: 'thread/start failed', thread }

  const turn = await rpc($, socketPath, '/call', {
    method: 'turn/start',
    params: {
      threadId,
      effort: 'low',
      input: [{
        type: 'text',
        text: 'Call the cbp4_echo tool exactly once with {"word":"ping"}. Then reply with only the text the tool returned, nothing else.',
        text_elements: [],
      }],
    },
  })
  log($, { ev: 'turn.start', mode, response: turn })

  let cursor = (await rpc($, socketPath, '/events?after=0&waitMs=0')).cursor
  let answer: string | undefined
  let completed: unknown
  let toolCalls = 0
  const t0 = Date.now()
  while (completed === undefined && Date.now() - t0 < TURN_DEADLINE_MS) {
    const budgetBefore = budget()
    const page = await rpc($, socketPath, `/events?after=${cursor}&waitMs=8000`)
    log($, { ev: 'poll', mode, cursor, waitedMs: page.waitedMs, got: page.events.length, budgetBefore, budgetAfter: budget() })
    cursor = page.cursor
    for (const { msg } of page.events) {
      if (msg.params?.threadId !== threadId) continue
      if (msg.method === 'item/tool/call') {
        toolCalls++
        log($, { ev: 'server.request', mode, msg })
        await rpc($, socketPath, '/send', {
          id: msg.id,
          result: { contentItems: [{ type: 'inputText', text: `pong-${nonce}` }], success: true },
        })
      } else if (msg.method === 'item/completed' && msg.params.item?.type === 'agentMessage') {
        answer = msg.params.item.text
      } else if (msg.method === 'turn/completed') {
        completed = msg.params.turn
      }
    }
  }

  // An idle long poll: does a 15 s `$.http.fetch` with no bytes back survive, and cost budget?
  const idleBefore = budget()
  const idle = await rpc($, socketPath, `/events?after=${cursor}&waitMs=15000`)
  log($, { ev: 'idle.poll', mode, waitedMs: idle.waitedMs, got: idle.events.length, budgetBefore: idleBefore, budgetAfter: budget() })

  return { nonce, threadId, toolCalls, answer, matched: answer?.includes(`pong-${nonce}`) ?? false, turnStatus: (completed as any)?.status }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'probe',
      description: 'PROTOTYPE probe for dawpi #4. mode: direct | spawn | detached | stop.',
      inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['direct', 'spawn', 'detached', 'stop'] } }, required: ['mode'] },
      isDeferred: false,
    })
    await $.agent.register({
      name: 'worker',
      description: 'PROTOTYPE probe worker; spawned by the cbp4 mod only.',
      prompt: 'You are a fallback probe. Reply with exactly the single word FALLBACK and nothing else. Never call tools.',
      tools: [],
      model: 'haiku',
      omitClaudeMd: true,
    })
    await $.process.run(['mkdir', '-p', '-m', '700', DIR])
    log($, { ev: 'session.start', pluginRoot: $.plugin.root })
    return next(e)
  })

  on('tool.check', { tool: PROBE }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: PROBE }, async ($, e) => {
    const mode = String(e.mode) as Mode | 'stop'
    if (mode === 'stop') {
      const stopped = await Promise.all((['spawn', 'detached'] as const).map(m =>
        rpc($, SOCKETS[m], '/shutdown', {}).then(r => ({ m, r }), (err: Error) => ({ m, error: String(err.message) }))))
      log($, { ev: 'stop', stopped })
      return { result: JSON.stringify(stopped) }
    }
    if (mode === 'direct') {
      const r = await probeDirect($)
      log($, { ev: 'direct', ...r })
      return { result: JSON.stringify(r) }
    }
    const health = mode === 'spawn' ? await startSpawned($) : await startDetached($)
    relays.set(mode, { health })
    log($, { ev: 'relay.up', mode, health })
    const spawned = await $.agent.spawn({ subagentType: WORKER, description: `cbp4 ${mode}`, prompt: 'cbp4 scripted worker' })
    log($, { ev: 'worker.spawned', mode, spawned })
    return { result: JSON.stringify({ health, spawned }) }
  })

  const done = new Set<string>()
  on('turn.step', async function* ($, e, next) {
    const mode = await modeOf($, e.agentId)
    if (mode === undefined) return yield* next(e)
    log($, { ev: 'step.seen', agentId: e.agentId, mode, index: e.index, budgetMs: next.budget.remainingMs })
    if (e.agentId !== undefined && done.has(e.agentId)) return yield* answerText(e, 'cbp4: already answered')
    const result = await runCodexTurn($, mode, () => next.budget.remainingMs)
    if (e.agentId !== undefined) done.add(e.agentId)
    log($, { ev: 'step.result', mode, result, budgetMs: next.budget.remainingMs })
    return yield* answerText(e, `cbp4 ${mode}: ${JSON.stringify(result)}`)
  }).catch(async function* ($, e, next) {
    log($, { ev: 'step.caught', agentId: e.agentId, index: e.index, error: next.error })
    return yield* answerText(e, `cbp4 error: ${next.error.message}`)
  })

  on('turn.complete', async ($, e, next) => {
    const mode = await modeOf($, e.agentId)
    if (mode !== undefined) log($, { ev: 'turn.complete', agentId: e.agentId, mode, reason: e.reason, answer: e.answer, usage: e.usage ?? null })
    return next(e)
  })
}

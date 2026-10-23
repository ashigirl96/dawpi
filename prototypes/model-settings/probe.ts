// PROTOTYPE (dawpi #17): throwaway. Answers which value Bridge can read to know the model and effort
// a Codex Turn actually ran with, and whether to pass them on thread/start, turn/start or thread/settings/update.
// usage: bun probe.ts <mock|live>

const [scenario] = Bun.argv.slice(2)

const CODEX_HOME = `${process.env.HOME}/.codex-bridge/codex-home`
const WORK = new URL('.', import.meta.url).pathname
const LOG = `${WORK}logs/${scenario}.json`
const BRIDGE_ARGS = [
  '-c', 'agents.enabled=false',
  '--disable', 'multi_agent',
  '--disable', 'multi_agent_v2',
  '--disable', 'guardian_approval',
  '--disable', 'apps',
  '--disable', 'plugins',
  '-c', 'approvals_reviewer="user"',
]
const M1 = 'gpt-5.6-luna'
const M2 = 'gpt-6-luna'

const t0 = Date.now()
const log: any[] = []
const results: any[] = []
const note = (conn: string, dir: string, msg: unknown) => {
  log.push({ t: Date.now() - t0, conn, dir, msg })
  console.log(JSON.stringify({ t: Date.now() - t0, conn, dir, msg }).slice(0, 200))
}
const text = (s: string) => [{ type: 'text', text: s, text_elements: [] }]

const lines = async (stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) => {
  let buf = ''
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.trim()) onLine(line)
    }
  }
}

// A fake Responses API: records the model and reasoning of every request Codex sends.
// `hold` parks the next request until released, so the client can act while a turn waits on the model.
function mockModel() {
  const requests: any[] = []
  let route: (body: any, n: number) => any[] = () => [say('ok')]
  let hold: { arrived: () => void; release: Promise<void> } | undefined
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json()
      requests.push(body)
      note('mock', 'request', { model: body.model, reasoning: body.reasoning })
      if (hold) {
        const h = hold
        hold = undefined
        h.arrived()
        await h.release
      }
      const id = `resp_${requests.length}`
      const events = [
        { type: 'response.created', response: { id } },
        ...route(body, requests.length).map(item => ({ type: 'response.output_item.done', item })),
        { type: 'response.completed', response: { id, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } },
      ]
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const args = ['-c', 'model_provider="mock"', '-c', 'model_providers.mock.name="mock"', '-c', `model_providers.mock.base_url="http://127.0.0.1:${server.port}/v1"`, '-c', 'model_providers.mock.wire_api="responses"']
  const holdNext = () => {
    let arrived!: () => void
    let release!: () => void
    const arrival = new Promise<void>(r => (arrived = r))
    hold = { arrived, release: new Promise<void>(r => (release = r)) }
    return { arrival, release }
  }
  return { requests, args, setRoute: (r: typeof route) => (route = r), holdNext, stop: () => server.stop(true) }
}
const say = (s: string) => ({ type: 'message', role: 'assistant', id: `msg_${crypto.randomUUID()}`, content: [{ type: 'output_text', text: s }] })
const execJs = (code: string) => ({ type: 'custom_tool_call', id: `ctc_${crypto.randomUUID()}`, call_id: `call_${crypto.randomUUID()}`, name: 'exec', input: code })

function connect(name: string, codexArgs: string[]) {
  const proc = Bun.spawn(['codex', 'app-server', ...BRIDGE_ARGS, ...codexArgs], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CODEX_HOME } })
  void lines(proc.stderr, l => note(name, 'stderr', l))
  const inbox: any[] = []
  const pending = new Map<number, (m: any) => void>()
  let wake: (() => void)[] = []
  let nextId = 1
  const write = (msg: unknown) => {
    note(name, 'out', msg)
    proc.stdin.write(JSON.stringify(msg) + '\n')
    proc.stdin.flush()
  }
  const call = (method: string, params: unknown) =>
    new Promise<any>(resolve => {
      const id = nextId++
      pending.set(id, resolve)
      write({ id, method, params })
    })
  const waitFor = async (pred: (m: any) => boolean, timeoutMs: number, from = 0) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = inbox.slice(from).find(pred)
      if (hit) return hit
      const left = deadline - Date.now()
      if (left <= 0) return null
      await new Promise<void>(r => {
        const timer = setTimeout(r, left)
        wake.push(() => (clearTimeout(timer), r()))
      })
    }
  }
  void lines(proc.stdout, line => {
    const msg = JSON.parse(line)
    note(name, 'in', msg)
    if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
    }
    if (msg.id !== undefined && msg.method?.endsWith('requestApproval')) write({ id: msg.id, result: { decision: 'decline' } })
    inbox.push(msg)
    const woken = wake
    wake = []
    woken.forEach(w => w())
  })
  const initialize = async () => {
    await call('initialize', { clientInfo: { name: `cbp17-${name}`, title: null, version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } })
    write({ method: 'initialized' })
  }
  return { name, inbox, write, call, waitFor, initialize, kill: () => proc.kill() }
}
type Conn = ReturnType<typeof connect>

const startThread = async (c: Conn, params: object) => {
  const r = await c.call('thread/start', { cwd: WORK, ephemeral: false, approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user', ...params })
  return r.error ? { error: r.error } : { threadId: r.result.thread.id, response: { model: r.result.model, reasoningEffort: r.result.reasoningEffort } }
}

// One Codex Turn with whatever overrides `params` carries; returns what every observable says about it.
const runTurn = async (c: Conn, threadId: string, params: object, during?: (turnId: string) => Promise<unknown>) => {
  const from = c.inbox.length
  const r = await c.call('turn/start', { threadId, input: text('Reply with exactly OK.'), ...params })
  if (r.error) return { turnStartError: r.error }
  const turnId = r.result.turn.id
  const duringResult = during ? await during(turnId) : undefined
  const done = await c.waitFor(m => m.method === 'turn/completed' && m.params.turn.id === turnId, 120_000, from)
  const msgs = c.inbox.slice(from)
  return {
    turnId,
    status: done?.params.turn.status ?? 'timeout',
    error: done?.params.turn.error ?? null,
    duringResult,
    notifications: msgs
      .filter(m => ['thread/settings/updated', 'model/rerouted', 'model/verification', 'error', 'warning'].includes(m.method) || m.method?.startsWith('config'))
      .map(m => ({ method: m.method, params: m.method === 'thread/settings/updated' ? pickSettings(m.params.threadSettings) : m.params })),
    reply: msgs.filter(m => m.method === 'item/completed' && m.params.item.type === 'agentMessage').map(m => m.params.item.text).join('\n'),
  }
}
const pickSettings = (s: any) => ({ model: s.model, modelProvider: s.modelProvider, effort: s.effort })
const threadRead = async (c: Conn, threadId: string) => {
  const r = await c.call('thread/read', { threadId })
  return r.error ? { error: r.error } : { model: r.result.thread.model, reasoningEffort: r.result.thread.reasoningEffort }
}
const rollout = async (threadId: string) => {
  const path = (await Bun.$`grep -rl ${threadId} ${CODEX_HOME}/sessions`.nothrow().text()).trim().split('\n')[0]
  if (!path) return null
  return (await Bun.file(path).text()).trim().split('\n').map(l => JSON.parse(l)).filter(e => e.type === 'turn_context').map(e => ({ turn_id: e.payload.turn_id, model: e.payload.model, effort: e.payload.effort }))
}

// Each step is a Codex Turn (or a settings call between turns) on one thread; the mock records what reached the model.
async function mock() {
  const m = mockModel()
  const step = async (c: Conn, threadId: string, label: string, turnParams: object, during?: (turnId: string) => Promise<unknown>) => {
    const start = m.requests.length
    const turn = await runTurn(c, threadId, turnParams, during)
    return { label, turnParams, ...turn, requests: m.requests.slice(start).map(b => ({ model: b.model, effort: b.reasoning?.effort ?? null })), threadRead: await threadRead(c, threadId) }
  }
  const c = connect('mock', m.args)
  await c.initialize()

  // 1. thread/start only, then turns that pass nothing.
  {
    const t = await startThread(c, { model: M1, config: { model_reasoning_effort: 'low' } })
    const steps = [await step(c, t.threadId!, 'turn 1: nothing', {}), await step(c, t.threadId!, 'turn 2: nothing', {})]
    results.push({ case: '1-thread-start-only', threadStart: t.response, steps, rollout: await rollout(t.threadId!) })
  }
  // 2. turn/start every time; a turn that passes nothing keeps the last override.
  {
    const t = await startThread(c, { model: M1 })
    const steps = [
      await step(c, t.threadId!, 'turn 1: M1 low', { model: M1, effort: 'low' }),
      await step(c, t.threadId!, 'turn 2: M2 high', { model: M2, effort: 'high' }),
      await step(c, t.threadId!, 'turn 3: nothing', {}),
      await step(c, t.threadId!, 'turn 4: ultra', { effort: 'ultra' }),
    ]
    results.push({ case: '2-turn-start-each', threadStart: t.response, threadId: t.threadId, steps, rollout: await rollout(t.threadId!) })
  }
  // 3. thread/settings/update between turns, as `configure` with apply: next-turn would.
  {
    const t = await startThread(c, { model: M1, config: { model_reasoning_effort: 'low' } })
    const s1 = await step(c, t.threadId!, 'turn 1: nothing', {})
    const from = c.inbox.length
    const update = await c.call('thread/settings/update', { threadId: t.threadId, model: M2, effort: 'high' })
    await Bun.sleep(300)
    const updated = c.inbox.slice(from).filter(x => x.method === 'thread/settings/updated').map(x => pickSettings(x.params.threadSettings))
    const s2 = await step(c, t.threadId!, 'turn 2: nothing', {})
    results.push({ case: '3-thread-settings-update', threadStart: t.response, steps: [s1, { label: 'thread/settings/update M2 high', response: update.result ?? update.error, notified: updated, threadRead: await threadRead(c, t.threadId!) }, s2], rollout: await rollout(t.threadId!) })
  }
  // 4. turn/settings/update while the turn waits on the model; the model then calls a tool so a second request follows.
  {
    const t = await startThread(c, { model: M1, config: { model_reasoning_effort: 'low' } })
    const first = m.requests.length + 1
    m.setRoute((_body, n) => (n === first ? [execJs('text("tool ran")')] : [say('OK')]))
    const h = m.holdNext()
    const s1 = await step(c, t.threadId!, 'turn 1: M1 low, turn/settings/update to M2 high mid-turn', {}, async turnId => {
      await h.arrival
      const r = await c.call('turn/settings/update', { threadId: t.threadId, turnId, model: M2, effort: 'high' })
      h.release()
      return r.result ?? r.error
    })
    m.setRoute(() => [say('OK')])
    const s2 = await step(c, t.threadId!, 'turn 2: nothing', {})
    results.push({ case: '4-turn-settings-update', threadStart: t.response, steps: [s1, s2], rollout: await rollout(t.threadId!) })
  }
  // 6. thread/settings/update sent while a turn waits on the model: does the running turn change mid-way?
  {
    const t = await startThread(c, { model: M1, config: { model_reasoning_effort: 'low' } })
    const first = m.requests.length + 1
    m.setRoute((_body, n) => (n === first ? [execJs('text("tool ran")')] : [say('OK')]))
    const h = m.holdNext()
    const s1 = await step(c, t.threadId!, 'turn 1: M1 low, thread/settings/update to M2 high mid-turn', {}, async () => {
      await h.arrival
      const r = await c.call('thread/settings/update', { threadId: t.threadId, model: M2, effort: 'high' })
      h.release()
      return r.result ?? r.error
    })
    m.setRoute(() => [say('OK')])
    const s2 = await step(c, t.threadId!, 'turn 2: nothing', {})
    results.push({ case: '6-thread-settings-update-mid-turn', threadStart: t.response, steps: [s1, s2], rollout: await rollout(t.threadId!) })
  }
  c.kill()

  // 5. A new connection resumes case 2's thread (last override M2 high, then ultra): what does the next turn use?
  const resumed = results.find(r => r.case === '2-turn-start-each')!.threadId
  for (const [label, params] of [['resume: nothing', {}], ['resume: model M1', { model: M1 }], ['resume: model M1 + config effort low', { model: M1, config: { model_reasoning_effort: 'low' } }]] as const) {
    const c2 = connect('mock-resume', m.args)
    await c2.initialize()
    const r = await c2.call('thread/resume', { threadId: resumed, ...params })
    const s = await step(c2, resumed, `${label}, then turn: nothing`, {})
    results.push({ case: `5-${label}`, resumeResponse: r.result ? { model: r.result.model, reasoningEffort: r.result.reasoningEffort } : r.error, steps: [s] })
    c2.kill()
  }
  results.push({ case: '5-rollout', rollout: await rollout(resumed) })
  m.stop()
}

// Real provider, cheapest model: what the catalog says, and how unknown models and unsupported efforts are answered.
async function live() {
  const c = connect('live', [])
  await c.initialize()
  const list = await c.call('model/list', { includeHidden: true })
  const models = (list.result?.data ?? []).map((x: any) => ({ id: x.id, model: x.model, hidden: x.hidden, efforts: x.supportedReasoningEfforts.map((e: any) => e.reasoningEffort), default: x.defaultReasoningEffort, upgrade: x.upgrade }))
  results.push({ case: 'model/list', models })
  const luna = models.find((x: any) => x.id === M1)
  const unsupported = ['minimal', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].find(e => !luna?.efforts.includes(e)) ?? 'minimal'
  const cases: [string, object, object][] = [
    ['baseline M1 low', { model: M1 }, { model: M1, effort: 'low' }],
    ['thread/start unknown model', { model: 'gpt-nope-1' }, {}],
    ['turn/start unknown model', { model: M1 }, { model: 'gpt-nope-1', effort: 'low' }],
    [`turn/start effort the catalog does not list (${unsupported})`, { model: M1 }, { model: M1, effort: unsupported }],
    ['turn/start effort that is not a word Codex knows', { model: M1 }, { model: M1, effort: 'banana' }],
  ]
  for (const [label, threadParams, turnParams] of cases) {
    const t = await startThread(c, threadParams)
    if ('error' in t) {
      results.push({ case: label, threadStartError: t.error })
      continue
    }
    const turn = await runTurn(c, t.threadId!, turnParams)
    const usage = c.inbox.filter(x => x.method === 'thread/tokenUsage/updated' && x.params.threadId === t.threadId).at(-1)?.params.tokenUsage.total
    results.push({ case: label, threadStart: t.response, turnParams, ...turn, threadRead: await threadRead(c, t.threadId!), rollout: await rollout(t.threadId!), usage })
  }
  c.kill()
}

const scenarios: Record<string, () => Promise<void>> = { mock, live }
if (!scenarios[scenario]) throw new Error(`usage: bun probe.ts <${Object.keys(scenarios).join('|')}>`)
try {
  await scenarios[scenario]()
} catch (e) {
  console.log('ERROR', e)
  results.push({ error: String(e) })
} finally {
  await Bun.write(LOG, JSON.stringify({ scenario, versions: { codex: '0.163.0', bun: Bun.version }, results, log }, null, 1))
  console.log(`RESULTS ${JSON.stringify(results, null, 1)}`)
  process.exit(0)
}

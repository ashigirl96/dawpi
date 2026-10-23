// PROTOTYPE (dawpi #9): throwaway. Runs Codex Turns under the Bridge launch settings and
// records whether Codex's own delegation (multi-agent, auto review, review) can surface.
// usage: bun probe.ts <scenario>

const [scenario] = Bun.argv.slice(2)

const CODEX_HOME = `${process.env.HOME}/.codex-bridge/codex-home`
const WORK = new URL('.', import.meta.url).pathname
const LOG = `${WORK}logs/${scenario}.json`

// Bridge's launch flags; config.toml in CODEX_HOME says the same, the flags keep it independent of that file.
const BRIDGE_ARGS = [
  '-c', 'agents.enabled=false',
  '--disable', 'multi_agent',
  '--disable', 'multi_agent_v2',
  '--disable', 'guardian_approval',
  '--disable', 'apps',
  '--disable', 'plugins',
  '-c', 'approvals_reviewer="user"',
]
// Control: what the same CODEX_HOME does when delegation is left on, to prove the tripwires can fire.
const OPEN_ARGS = ['-c', 'agents.enabled=true', '--enable', 'multi_agent']
const PROFILES: Record<string, string[]> = { bridge: BRIDGE_ARGS, open: OPEN_ARGS }

const COLLAB_WORDS = ['spawn_agent', 'send_input', 'wait_agent', 'close_agent', 'resume_agent', 'spawn_agents', 'multi_agent', 'collab']
const DELEGATING_PROMPT =
  'This task is large. Delegate it: spawn a sub-agent (or several in parallel) to list the files in the current directory, wait for it, and report what it found. If you have no tool for spawning agents, reply with exactly NO_AGENT_TOOLS followed by the names of every tool you can call.'

const t0 = Date.now()
const log: any[] = []
const results: any[] = []
const note = (conn: string, dir: string, msg: unknown) => {
  const e = { t: Date.now() - t0, conn, dir, msg }
  log.push(e)
  console.log(JSON.stringify(e).slice(0, 240))
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

// A fake Responses API: records what Codex would send the model and replies through a router.
type Reply = (body: any) => any[]
const say = (s: string): Reply => () => [{ type: 'message', role: 'assistant', id: `msg_${crypto.randomUUID()}`, content: [{ type: 'output_text', text: s }] }]
const callTool = (name: string, args: object, namespace?: string): Reply => () => [
  { type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: `call_${crypto.randomUUID()}`, name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args) },
]
const agentName = (body: any) => JSON.parse(body.client_metadata?.['x-codex-turn-metadata'] ?? '{}').agent_name
const toolOutputs = (body: any) => (body.input ?? []).filter((i: any) => i.type?.endsWith('_call_output'))
const runJs = (code: string): Reply => () => [
  { type: 'custom_tool_call', id: `ctc_${crypto.randomUUID()}`, call_id: `call_${crypto.randomUUID()}`, name: 'exec', input: code },
]
function mockModel() {
  const requests: any[] = []
  let route: Reply = say('ok')
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== 'POST' || !url.pathname.endsWith('/responses')) {
        note('mock', 'unhandled', `${req.method} ${url.pathname}`)
        return new Response('not found', { status: 404 })
      }
      const body = await req.json()
      requests.push(body)
      const items = route(body)
      note('mock', 'reply', { agent: agentName(body), items: items.map((i: any) => i.name ?? i.content?.[0]?.text) })
      const id = `resp_${requests.length}`
      const events = [
        { type: 'response.created', response: { id } },
        ...items.map(item => ({ type: 'response.output_item.done', item })),
        {
          type: 'response.completed',
          response: {
            id,
            usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
          },
        },
      ]
      const sse = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const args = [
    '-c', 'model_provider="mock"',
    '-c', 'model_providers.mock.name="mock"',
    '-c', `model_providers.mock.base_url="http://127.0.0.1:${server.port}/v1"`,
    '-c', 'model_providers.mock.wire_api="responses"',
  ]
  return { requests, args, setRoute: (r: Reply) => (route = r), stop: () => server.stop(true) }
}

function connect(name: string, codexArgs: string[]) {
  const proc = Bun.spawn(['codex', 'app-server', ...codexArgs], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CODEX_HOME },
  })
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
        wake.push(() => {
          clearTimeout(timer)
          r()
        })
      })
    }
  }
  void lines(proc.stdout, line => {
    const msg = JSON.parse(line)
    note(name, 'in', msg)
    const isResponse = msg.id !== undefined && msg.method === undefined
    if (isResponse && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
    }
    // Every approval the client is asked for is declined, so nothing escalated ever runs.
    if (msg.id !== undefined && msg.method?.endsWith('requestApproval')) write({ id: msg.id, result: { decision: 'decline' } })
    inbox.push(msg)
    const woken = wake
    wake = []
    woken.forEach(w => w())
  })

  const initialize = async () => {
    await call('initialize', {
      clientInfo: { name: `cbp9-${name}`, title: null, version: '0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    write({ method: 'initialized' })
  }
  const startThread = async (model: string, extra: object = {}) => {
    const r = await call('thread/start', {
      model,
      cwd: WORK,
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      approvalsReviewer: 'user',
      ...extra,
    })
    if (r.error) throw new Error(JSON.stringify(r.error))
    return r.result
  }
  const runTurn = async (threadId: string, model: string, effort: string, prompt: string, timeoutMs = 180_000) => {
    const from = inbox.length
    const r = await call('turn/start', { threadId, input: text(prompt), model, effort })
    if (r.error) return { error: r.error }
    const turnId = r.result.turn.id
    const done = await waitFor(m => m.method === 'turn/completed' && m.params.turn.id === turnId, timeoutMs, from)
    const msgs = inbox.slice(from)
    return {
      turnId,
      status: done?.params.turn.status ?? 'timeout',
      methods: [...new Set(msgs.map(m => m.method ?? 'response'))],
      items: msgs.filter(m => m.method === 'item/completed').map(m => m.params.item),
      reply: msgs
        .filter(m => m.method === 'item/completed' && m.params.item.type === 'agentMessage')
        .map(m => m.params.item.text)
        .join('\n'),
      tripwires: tripwires(msgs),
    }
  }
  return { name, proc, inbox, write, call, waitFor, initialize, startThread, runTurn, kill: () => proc.kill() }
}

// Anything here means Codex delegated on its own; Bridge would stop the Run.
const tripwires = (msgs: any[]) =>
  msgs.filter(
    m =>
      ['item/started', 'item/completed'].includes(m.method) && ['collabAgentToolCall', 'subAgentActivity', 'enteredReviewMode', 'exitedReviewMode'].includes(m.params.item.type) ||
      m.method?.startsWith('item/autoApprovalReview/') ||
      m.method === 'autoApprovalReview/strictReviewRequired' ||
      m.method === 'thread/started' && m.params.thread?.source && JSON.stringify(m.params.thread.source).includes('subAgent'),
  ).map(m => ({ method: m.method, type: m.params.item?.type }))

const rolloutContexts = async (threadId: string) => {
  const path = (await Bun.$`grep -rl ${threadId} ${CODEX_HOME}/sessions`.nothrow().text()).trim().split('\n')[0]
  if (!path) return null
  return (await Bun.file(path).text())
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
    .filter(e => e.type === 'session_meta' || e.type === 'turn_context')
    .map(e => ({ type: e.type, multi_agent_version: e.payload.multi_agent_version, approvals_reviewer: e.payload.approvals_reviewer, effort: e.payload.effort, model: e.payload.model }))
}

// Codex sends the tools as an `additional_tools` input item, not the top-level `tools` field.
const toolSpecs = (body: any) => [...(body.tools ?? []), ...(body.input ?? []).filter((i: any) => i.type === 'additional_tools').flatMap((i: any) => i.tools)]
// Code mode lists the tools reachable from `exec` as `### \`name\`` headings in its description.
const toolNames = (body: any) =>
  toolSpecs(body).flatMap((t: any) =>
    t.type === 'namespace'
      ? (t.tools ?? []).flatMap((x: any) => [
          `${t.name}.${x.name}`,
          ...[...(x.name === 'exec' ? x.description.matchAll(/### `([a-z_]+)`/g) : [])].map(m => `${t.name}.exec>${m[1]}`),
        ])
      : [t.name ?? t.type],
  )
const collabMentions = (value: unknown) => {
  const s = JSON.stringify(value) ?? ''
  return COLLAB_WORDS.filter(w => s.includes(w))
}
const developerTags = (body: any) => {
  const s = JSON.stringify(body.input ?? '') + JSON.stringify(body.instructions ?? '')
  return ['<multi_agent_role>', '<multi_agent_mode>'].filter(tag => s.includes(tag))
}

// What Codex would hand the model, per profile, model and effort; the model is the mock, so no tokens are spent.
async function tools() {
  const mock = mockModel()
  for (const profile of ['bridge', 'open']) {
    const c = connect(profile, [...PROFILES[profile], ...mock.args])
    await c.initialize()
    for (const model of ['gpt-5.6-luna', 'gpt-6-luna']) {
      for (const effort of ['low', 'ultra']) {
        const start = mock.requests.length
        const thread = await c.startThread(model)
        const turn = await c.runTurn(thread.thread.id, model, effort, DELEGATING_PROMPT, 30_000)
        const reqs = mock.requests.slice(start)
        results.push({
          profile,
          model,
          effort,
          threadStart: { model: thread.model, reasoningEffort: thread.reasoningEffort, approvalsReviewer: thread.approvalsReviewer },
          turnStatus: turn.status,
          tripwires: turn.tripwires,
          rollout: await rolloutContexts(thread.thread.id),
          requests: reqs.map(b => ({ model: b.model, reasoning: b.reasoning, tools: toolNames(b), collabInTools: collabMentions(toolSpecs(b)), developerTags: developerTags(b) })),
        })
      }
    }
    c.kill()
  }
  await Bun.write(`${WORK}logs/tools-requests.json`, JSON.stringify(mock.requests, null, 1))
  mock.stop()
}

// The mock model calls collab tools it was never offered, to see whether Codex runs them anyway.
async function forced() {
  const mock = mockModel()
  const model = 'gpt-6-luna'
  const attempts: [string, string | undefined][] = [
    ['spawn_agent', 'collaboration'],
    ['spawn_agent', undefined],
    ['spawn_agent', 'multi_agent_v1'],
  ]
  for (const profile of ['bridge', 'open']) {
    const c = connect(profile, [...PROFILES[profile], ...mock.args])
    await c.initialize()
    for (const [name, namespace] of attempts) {
      mock.setRoute(body => {
        if (agentName(body) !== '/root') return say('CHILD_DONE')(body)
        const outputs = toolOutputs(body).length
        if (outputs === 0) return callTool(name, { task_name: 'lister', message: 'Reply with exactly CHILD_DONE.' }, namespace)(body)
        if (outputs === 1) return callTool('wait_agent', { timeout_ms: 15000 }, namespace)(body)
        return say('ROOT_DONE')(body)
      })
      const start = mock.requests.length
      const thread = await c.startThread(model)
      const turn = await c.runTurn(thread.thread.id, model, 'low', DELEGATING_PROMPT, 60_000)
      const reqs = mock.requests.slice(start)
      results.push({
        profile,
        attempt: namespace ? `${namespace}.${name}` : name,
        turnStatus: turn.status,
        tripwires: turn.tripwires,
        itemTypes: turn.items.map((i: any) => i.type),
        childRequests: reqs.filter(b => agentName(b) !== '/root').length,
        toolOutputs: toolOutputs(reqs.at(-1) ?? {}).map((o: any) => o.output),
        reply: turn.reply,
        threadsLoaded: (await c.call('thread/loaded/list', {})).result,
      })
    }
    c.kill()
  }
  mock.stop()
}

// An escalated command under on-request: who is asked to approve it, the client or a guardian sub-agent?
async function reviewer() {
  const mock = mockModel()
  const model = 'gpt-6-luna'
  const cases = [
    { label: 'bridge', args: BRIDGE_ARGS, threadReviewer: 'user' },
    { label: 'bridge+threadAutoReview', args: BRIDGE_ARGS, threadReviewer: 'auto_review' },
    { label: 'autoReview', args: [...OPEN_ARGS, '--enable', 'guardian_approval', '-c', 'approvals_reviewer="auto_review"'], threadReviewer: 'auto_review' },
  ]
  mock.setRoute(body => {
    if (agentName(body) !== '/root') return say('{"outcome":"deny","risk_level":"high","rationale":"prototype mock"}')(body)
    if (toolOutputs(body).length === 0)
      return runJs(
        'const r = await tools.exec_command({cmd: "touch PROTOTYPE-escalated.txt", sandbox_permissions: "require_escalated", justification: "prototype probe"}); text(JSON.stringify(r));',
      )(body)
    return say('ROOT_DONE')(body)
  })
  for (const k of cases) {
    const c = connect(k.label, [...k.args, ...mock.args])
    await c.initialize()
    const start = mock.requests.length
    const from = c.inbox.length
    const thread = await c.startThread(model, { approvalPolicy: 'on-request', approvalsReviewer: k.threadReviewer })
    const turn = await c.runTurn(thread.thread.id, model, 'low', 'Create the file PROTOTYPE-escalated.txt.', 120_000)
    const reqs = mock.requests.slice(start)
    results.push({
      case: k.label,
      threadStart: { approvalsReviewer: thread.approvalsReviewer, approvalPolicy: thread.approvalPolicy },
      turnStatus: turn.status,
      tripwires: turn.tripwires,
      serverRequests: c.inbox.slice(from).filter(m => m.id !== undefined && m.method).map(m => m.method),
      nonRootRequests: reqs.filter(b => agentName(b) !== '/root').map(b => agentName(b) ?? b.client_metadata?.['x-openai-subagent'] ?? 'unknown'),
      toolOutputs: toolOutputs(reqs.at(-1) ?? {}).map((o: any) => JSON.stringify(o.output).slice(0, 300)),
      fileCreated: await Bun.file(`${WORK}PROTOTYPE-escalated.txt`).exists(),
    })
    c.kill()
  }
  mock.stop()
}

// The startup reads Bridge would check before the first Codex Turn; no turn runs, so no tokens are spent.
async function checks() {
  const watched = ['agents.enabled', 'features.multi_agent', 'features.multi_agent_v2', 'features.guardian_approval', 'features.apps', 'features.plugins', 'approvals_reviewer']
  const flatten = (o: any, prefix = ''): Record<string, unknown> =>
    Object.entries(o ?? {}).reduce(
      (acc, [k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? { ...acc, ...flatten(v, `${prefix}${k}.`) } : { ...acc, [`${prefix}${k}`]: v }),
      {} as Record<string, unknown>,
    )
  for (const profile of ['bridge', 'open']) {
    const c = connect(profile, PROFILES[profile])
    await c.initialize()
    const config = (await c.call('config/read', { includeLayers: true })).result
    const features = (await c.call('experimentalFeature/list', {})).result
    const requirements = (await c.call('configRequirements/read', {})).result
    const thread = await c.startThread('gpt-6-luna', { ephemeral: true })
    const pick = (o: Record<string, unknown>) => Object.fromEntries(watched.map(k => [k, o[k]]))
    results.push({
      profile,
      effective: pick(flatten(config.config)),
      layers: config.layers?.map((l: any) => ({ source: l.name?.type ?? l.source?.type ?? l.name, ...Object.fromEntries(Object.entries(pick(flatten(l.config))).filter(([, v]) => v !== undefined)) })),
      features: (features.data ?? features).filter((f: any) => ['multi_agent', 'multi_agent_v2', 'guardian_approval', 'apps', 'plugins'].includes(f.name)).map((f: any) => `${f.name}=${f.enabled}`),
      requirements,
      threadStart: { ...thread, thread: undefined, instructionSources: thread.instructionSources },
      mcpServers: (await c.call('mcpServerStatus/list', {})).result,
    })
    c.kill()
  }
}

// Real Codex Turns on cheap models; the `open` run shows the prompt does make the model delegate when it can.
async function live() {
  const runs = [
    { profile: 'bridge', model: 'gpt-5.6-luna' },
    { profile: 'bridge', model: 'gpt-6-luna' },
    { profile: 'open', model: 'gpt-6-luna' },
  ]
  for (const r of runs) {
    const c = connect(`${r.profile}-${r.model}`, PROFILES[r.profile])
    await c.initialize()
    const thread = await c.startThread(r.model, { experimentalRawEvents: true })
    const turn = await c.runTurn(thread.thread.id, r.model, 'low', DELEGATING_PROMPT, 300_000)
    const raw = c.inbox.filter(m => m.method === 'rawResponseItem/completed' && m.params.threadId === thread.thread.id).map(m => m.params.item)
    const usage = c.inbox.filter(m => m.method === 'thread/tokenUsage/updated').at(-1)?.params.tokenUsage.total
    results.push({
      ...r,
      turnStatus: turn.status,
      tripwires: turn.tripwires,
      itemTypes: turn.items.map((i: any) => i.type),
      modelCalls: raw.filter((i: any) => i.type?.endsWith('_call')).map((i: any) => ({ type: i.type, name: i.name, namespace: i.namespace, input: (i.input ?? i.arguments ?? '').slice(0, 300) })),
      reply: turn.reply,
      rollout: await rolloutContexts(thread.thread.id),
      usage,
    })
    c.kill()
  }
}

const scenarios: Record<string, () => Promise<void>> = { tools, forced, reviewer, checks, live }
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

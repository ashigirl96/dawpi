// PROTOTYPE (dawpi #3): throwaway. Holds the answer to a Codex dynamic tool call
// (`item/tool/call`) and records what `codex app-server` does meanwhile.
// usage: bun probe.ts <hold|peek|patient|interrupt|steer|eof|reconnect> [codex app-server args...]

import { existsSync } from 'node:fs'

const [scenario, ...codexArgs] = Bun.argv.slice(2)

const CODEX_HOME = `${process.env.HOME}/.codex-bridge/codex-home`
const MODEL = 'gpt-5.6-luna'
const WORK = new URL('.', import.meta.url).pathname
const LOG = `${WORK}logs/${[scenario, ...codexArgs.filter(a => !a.startsWith('-'))].join('+')}.json`
// Unix socket paths are capped near 100 bytes, so the scratchpad is too deep.
const SOCK = '/tmp/cbp3/s.sock'

const TOOL = {
  type: 'function',
  name: 'bridge_delegate',
  description: 'Delegate a task to another agent. Returns a receipt text.',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string' } },
    required: ['task'],
    additionalProperties: false,
  },
}
const PROMPT =
  'Call the tool bridge_delegate exactly once with task "ping". Then reply with exactly the text the tool returned, nothing else.'

const t0 = Date.now()
const log: any[] = []
const results: any[] = []
const note = (conn: string, dir: string, msg: unknown) => {
  const e = { t: Date.now() - t0, conn, dir, msg }
  log.push(e)
  console.log(JSON.stringify(e).slice(0, 300))
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const nonce = () => Math.random().toString(36).slice(2, 8)
const text = (s: string) => [{ type: 'text', text: s, text_elements: [] }]
const answer = (id: unknown, s: string) => ({
  id,
  result: { success: true, contentItems: [{ type: 'inputText', text: s }] },
})

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

type Wire = {
  send: (text: string) => void
  end: () => void
  kill: () => void
  run: (onMessage: (text: string) => void) => Promise<unknown>
}

// `codex app-server` as a child; the connection lives exactly as long as the process.
const stdio = (name: string): Wire => {
  const proc = Bun.spawn(['codex', 'app-server', ...codexArgs], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CODEX_HOME },
  })
  void lines(proc.stderr, l => note(name, 'stderr', l))
  return {
    send: text => {
      proc.stdin.write(text + '\n')
      proc.stdin.flush()
    },
    end: () => proc.stdin.end(),
    kill: () => proc.kill(),
    run: async onMessage => {
      await lines(proc.stdout, onMessage)
      return { exit: await proc.exited }
    },
  }
}

// A client of a long-lived `codex app-server --listen unix://`; the socket only speaks WebSocket.
const ws = (path: string): Wire => {
  const sock = new WebSocket(`ws+unix://${path}`)
  const open = new Promise(r => (sock.onopen = r))
  return {
    send: text => void open.then(() => sock.send(text)),
    end: () => sock.close(),
    kill: () => sock.close(),
    run: onMessage =>
      new Promise(resolve => {
        sock.onmessage = e => onMessage(String(e.data))
        sock.onclose = e => resolve({ code: e.code, reason: e.reason })
      }),
  }
}

function connect(name: string, wire: Wire) {
  const inbox: any[] = []
  const pending = new Map<number, (m: any) => void>()
  let wake: (() => void)[] = []
  let nextId = 1

  const write = (msg: unknown) => {
    note(name, 'out', msg)
    wire.send(JSON.stringify(msg))
  }
  const call = (method: string, params: unknown) =>
    new Promise<any>(resolve => {
      const id = nextId++
      pending.set(id, resolve)
      write({ id, method, params })
    })
  // Resolves with the first inbox message at index >= from that matches, or null on timeout.
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

  const closed = (async () => {
    const end = await wire.run(line => {
      const msg = JSON.parse(line)
      note(name, 'in', msg)
      const isResponse = msg.id !== undefined && msg.method === undefined
      if (isResponse && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
      }
      inbox.push(msg)
      const woken = wake
      wake = []
      woken.forEach(w => w())
    })
    note(name, "closed", end)
  })()

  const initialize = async () => {
    const r = await call('initialize', {
      clientInfo: { name: `cbp3-${name}`, title: null, version: '0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    write({ method: 'initialized' })
    return r
  }
  const startThread = async (ephemeral: boolean, extra: object = {}) => {
    const r = await call('thread/start', {
      model: MODEL,
      cwd: WORK,
      ephemeral,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      dynamicTools: [TOOL],
      ...extra,
    })
    return r.result.thread.id as string
  }
  const startTurn = async (threadId: string, prompt: string) => {
    const r = await call('turn/start', { threadId, input: text(prompt), model: MODEL, effort: 'low' })
    return r.result.turn.id as string
  }
  const toolCall = (threadId: string, timeoutMs: number, from = 0) =>
    waitFor(m => m.method === 'item/tool/call' && m.params.threadId === threadId, timeoutMs, from)
  const turnDone = (turnId: string, timeoutMs: number) =>
    waitFor(m => m.method === 'turn/completed' && m.params.turn.id === turnId, timeoutMs)
  const agentText = (turnId: string) =>
    inbox
      .filter(m => m.method === 'item/completed' && m.params.turnId === turnId && m.params.item.type === 'agentMessage')
      .map(m => m.params.item.text)
      .join('\n')
  const toolItem = (turnId: string) =>
    inbox.find(m => m.method === 'item/completed' && m.params.turnId === turnId && m.params.item.type === 'dynamicToolCall')
      ?.params.item ?? null

  return { name, wire, inbox, write, call, waitFor, closed, initialize, startThread, startTurn, toolCall, turnDone, agentText, toolItem }
}

type Conn = ReturnType<typeof connect>

const methodsBetween = (c: Conn, from: number) => c.inbox.slice(from).map(m => m.method ?? `response#${m.id}`)

async function hold() {
  const c = connect('A', stdio('A'))
  await c.initialize()
  const holds = [30_000, 5 * 60_000, 15 * 60_000]
  await Promise.all(
    holds.map(async holdMs => {
      const n = nonce()
      const threadId = await c.startThread(true)
      const turnId = await c.startTurn(threadId, PROMPT)
      const req = await c.toolCall(threadId, 120_000)
      const mark = c.inbox.length
      await sleep(holdMs)
      const duringHold = c.inbox.slice(mark).filter(m => m.params?.threadId === threadId).map(m => m.method)
      c.write(answer(req.id, `pong-${n}`))
      const done = await c.turnDone(turnId, 120_000)
      const reply = c.agentText(turnId)
      results.push({
        holdMs,
        duringHold,
        status: done?.params.turn.status ?? 'timeout',
        reply,
        matched: reply.includes(n),
        toolItem: c.toolItem(turnId),
      })
    }),
  )
  c.wire.kill()
}

async function interrupt() {
  const c = connect('A', stdio('A'))
  await c.initialize()
  const threadId = await c.startThread(true)
  const turnId = await c.startTurn(threadId, PROMPT)
  const req = await c.toolCall(threadId, 120_000)
  await sleep(10_000)
  const mark = c.inbox.length
  const interruptRes = await c.call('turn/interrupt', { threadId, turnId })
  const done = await c.turnDone(turnId, 60_000)
  await sleep(2_000)
  const afterInterrupt = methodsBetween(c, mark)
  const lateMark = c.inbox.length
  c.write(answer(req.id, `late-${nonce()}`))
  await sleep(5_000)
  const afterLate = c.inbox.slice(lateMark)
  const n = nonce()
  const turn2 = await c.startTurn(
    threadId,
    `What did bridge_delegate return in your previous turn? Answer in one line ("NONE" if nothing). Then call bridge_delegate once with task "again" and reply with its result too.`,
  )
  const req2 = await c.toolCall(threadId, 120_000, lateMark)
  if (req2) c.write(answer(req2.id, `pong2-${n}`))
  const done2 = await c.turnDone(turn2, 120_000)
  const read = await c.call('thread/read', { threadId, includeTurns: true })
  results.push({
    interruptRes,
    turnStatus: done?.params.turn.status ?? 'timeout',
    afterInterrupt,
    toolItem: c.toolItem(turnId),
    afterLate,
    turn2: { status: done2?.params.turn.status, reply: c.agentText(turn2), toolReissued: !!req2, matched: c.agentText(turn2).includes(n) },
    history: read.result?.thread.turns.map((t: any) => ({ id: t.id, status: t.status, items: t.items.map((i: any) => i.type) })),
  })
  c.wire.kill()
}

async function steer() {
  const c = connect('A', stdio('A'))
  await c.initialize()
  const threadId = await c.startThread(true)
  const turnId = await c.startTurn(threadId, PROMPT)
  const req = await c.toolCall(threadId, 120_000)
  await sleep(5_000)
  const steerRes = await c.call('turn/steer', {
    threadId,
    expectedTurnId: turnId,
    input: text('Additional instruction: append the word STEERED at the end of your final reply.'),
  })
  await sleep(10_000)
  const n = nonce()
  c.write(answer(req.id, `pong-${n}`))
  const done = await c.turnDone(turnId, 120_000)
  const reply = c.agentText(turnId)
  results.push({ steerRes, status: done?.params.turn.status, reply, matched: reply.includes(n), steered: reply.includes('STEERED') })
  c.wire.kill()
}

// While a call is held, Codex re-samples the model about every 30 s; the raw items show what it feeds back.
const peek = () => peekWith({}, 100_000)

// The 30 s comes from the yield_time_ms the model passes to code mode's `wait`.
const patient = () =>
  peekWith(
    {
      developerInstructions:
        'bridge_delegate can take many minutes to answer. While a cell is waiting on it, call wait with yield_time_ms 600000.',
    },
    200_000,
  )

async function peekWith(extra: object, holdMs: number) {
  const c = connect('A', stdio('A'))
  await c.initialize()
  const threadId = await c.startThread(false, { experimentalRawEvents: true, ...extra })
  const turnId = await c.startTurn(threadId, PROMPT)
  const req = await c.toolCall(threadId, 120_000)
  await sleep(holdMs)
  const n = nonce()
  c.write(answer(req.id, `pong-${n}`))
  const done = await c.turnDone(turnId, 120_000)
  const raw = c.inbox.filter(m => m.method === 'rawResponseItem/completed').map(m => m.params.item)
  const rollout = (await Bun.$`grep -rl ${threadId} ${CODEX_HOME}/sessions`.text()).trim()
  results.push({
    status: done?.params.turn.status,
    matched: c.agentText(turnId).includes(n),
    raw,
    rollout,
    rolloutItems: (await Bun.file(rollout).text())
      .trim()
      .split('\n')
      .map(l => JSON.parse(l))
      .filter(e => e.type === 'response_item')
      .map(e => e.payload),
  })
  c.wire.kill()
}

// The Codex turn outlives a lost stdio connection only if app-server survives it.
async function eof() {
  const a = connect('A', stdio('A'))
  await a.initialize()
  const threadId = await a.startThread(false)
  const turnId = await a.startTurn(threadId, PROMPT)
  const req = await a.toolCall(threadId, 120_000)
  await sleep(5_000)
  const t = Date.now()
  a.wire.end()
  const exited = await Promise.race([a.closed.then(() => Date.now() - t), sleep(15_000).then(() => 'still running')])
  if (exited === 'still running') a.wire.kill()

  const b = connect('B', stdio('B'))
  await b.initialize()
  const resume = await b.call('thread/resume', { threadId })
  const reissued = await b.toolCall(threadId, 20_000)
  const n = nonce()
  const turn2 = await b.startTurn(
    threadId,
    `What did bridge_delegate return in your previous turn? Answer in one line ("NONE" if nothing). Then call bridge_delegate once with task "again" and reply with its result too.`,
  )
  const req2 = await b.toolCall(threadId, 120_000)
  if (req2) b.write(answer(req2.id, `pong2-${n}`))
  const done2 = await b.turnDone(turn2, 120_000)
  results.push({
    threadId,
    heldRequestId: req.id,
    stdinEofToExitMs: exited,
    resume: {
      error: resume.error,
      status: resume.result?.thread.status,
      turns: resume.result?.thread.turns?.map((x: any) => ({ id: x.id, status: x.status, items: x.items.map((i: any) => `${i.type}:${i.status ?? ''}`) })),
    },
    oldTurnId: turnId,
    reissuedAfterResume: reissued,
    turn2: { status: done2?.params.turn.status, reply: b.agentText(turn2), toolCalled: !!req2, matched: b.agentText(turn2).includes(n) },
  })
  b.wire.kill()
}

// app-server keeps running on a socket while WebSocket clients come and go.
// `codex app-server proxy` only pipes bytes, so it does not spare the client the WebSocket framing.
async function reconnect() {
  await Bun.$`mkdir -p /tmp/cbp3 && chmod 700 /tmp/cbp3 && rm -f ${SOCK}`
  const server = Bun.spawn(['codex', 'app-server', ...codexArgs, '--listen', `unix://${SOCK}`], {
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ...process.env, CODEX_HOME },
  })
  void lines(server.stderr, l => note('server', 'stderr', l))
  // Bun.file().exists() reports false for a socket.
  while (!existsSync(SOCK)) await sleep(100)

  const c1 = connect('c1', ws(SOCK))
  await c1.initialize()
  const threadId = await c1.startThread(false)
  const turnId = await c1.startTurn(threadId, PROMPT)
  const req = await c1.toolCall(threadId, 120_000)
  await sleep(5_000)
  c1.wire.kill()
  await c1.closed
  await sleep(5_000)

  const c2 = connect('c2', ws(SOCK))
  await c2.initialize()
  const read = await c2.call('thread/read', { threadId, includeTurns: true })
  const resume = await c2.call('thread/resume', { threadId })
  const reissued = await c2.toolCall(threadId, 20_000)
  const n = nonce()
  const respondedWith = reissued ? 'reissued id' : 'old id from c1'
  const mark = c2.inbox.length
  c2.write(answer(reissued ? reissued.id : req.id, `pong-${n}`))
  const done = await c2.turnDone(turnId, 120_000)
  results.push({
    threadId,
    oldRequestId: req.id,
    readBeforeResume: read.result?.thread.status ?? read.error,
    resume: {
      error: resume.error,
      status: resume.result?.thread.status,
      turns: resume.result?.thread.turns?.map((x: any) => ({ id: x.id, status: x.status, items: x.items.map((i: any) => `${i.type}:${i.status ?? ''}`) })),
    },
    reissuedAfterResume: reissued,
    respondedWith,
    afterAnswer: c2.inbox.slice(mark).map(m => m.method ?? m),
    status: done?.params.turn.status ?? 'timeout',
    reply: c2.agentText(turnId),
    matched: c2.agentText(turnId).includes(n),
  })
  c2.wire.kill()
  server.kill()
  await Bun.$`rm -f ${SOCK}`
}

const scenarios: Record<string, () => Promise<void>> = { hold, peek, patient, interrupt, steer, eof, reconnect }
if (!scenarios[scenario]) throw new Error(`usage: bun probe.ts <${Object.keys(scenarios).join('|')}>`)
try {
  await scenarios[scenario]()
} finally {
  await Bun.write(LOG, JSON.stringify({ scenario, versions: { codex: '0.163.0', bun: Bun.version }, model: MODEL, results, log }, null, 1))
  console.log(`RESULTS ${JSON.stringify(results, null, 1)}`)
  process.exit(0)
}

// PROTOTYPE (dawpi #4): throwaway relay. Owns one `codex app-server` over stdio
// and serves it to the mod as HTTP over a Unix socket.
//   POST /call    {method, params}  -> the JSON-RPC response to that request
//   POST /send    a raw JSON-RPC message (answers to server requests)
//   GET  /events?after=N&waitMs=M   -> {cursor, waitedMs, events} long poll
//   GET  /health, POST /shutdown
// usage: bun relay.ts <socket> [codex app-server args...]

const [socketPath, ...codexArgs] = Bun.argv.slice(2)
export {}

if (!socketPath) throw new Error('usage: bun relay.ts <socket> [codex args...]')

const codex = Bun.spawn(['codex', 'app-server', ...codexArgs], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
})

type RelayEvent = { seq: number; at: number; msg: any }
const events: RelayEvent[] = []
const pending = new Map<number, (msg: any) => void>()
let waiters: (() => void)[] = []
let nextId = 1

const write = (msg: unknown) => {
  codex.stdin.write(JSON.stringify(msg) + '\n')
  codex.stdin.flush()
}

const call = (method: string, params: unknown) =>
  new Promise<any>(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    write({ id, method, params })
  })

void (async () => {
  let buf = ''
  for await (const chunk of codex.stdout.pipeThrough(new TextDecoderStream())) {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      const isResponse = msg.id !== undefined && msg.method === undefined
      if (isResponse && pending.has(msg.id)) {
        pending.get(msg.id)!(msg)
        pending.delete(msg.id)
        continue
      }
      events.push({ seq: events.length + 1, at: Date.now(), msg })
      const woken = waiters
      waiters = []
      woken.forEach(w => w())
    }
  }
  console.error(`relay: codex stdout closed, exit=${await codex.exited}`)
  process.exit(1)
})()

const init = await call('initialize', {
  clientInfo: { name: 'cbp4-relay', title: null, version: '0' },
  capabilities: { experimentalApi: true, requestAttestation: false },
})
write({ method: 'initialized' })

const waitForEvents = (after: number, waitMs: number) =>
  new Promise<void>(resolve => {
    if (events.length > after) return resolve()
    const timer = setTimeout(resolve, waitMs)
    waiters.push(() => {
      clearTimeout(timer)
      resolve()
    })
  })

const json = (body: unknown) => Response.json(body)

Bun.serve({
  unix: socketPath,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return json({ relayPid: process.pid, codexPid: codex.pid, initialize: init, events: events.length })
    }
    if (url.pathname === '/call' && req.method === 'POST') {
      const { method, params } = await req.json()
      return json(await call(method, params))
    }
    if (url.pathname === '/send' && req.method === 'POST') {
      write(await req.json())
      return json({ ok: true })
    }
    if (url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0)
      const waitMs = Number(url.searchParams.get('waitMs') ?? 0)
      const t0 = Date.now()
      await waitForEvents(after, waitMs)
      return json({ cursor: events.length, waitedMs: Date.now() - t0, events: events.slice(after) })
    }
    if (url.pathname === '/shutdown' && req.method === 'POST') {
      setTimeout(() => {
        codex.kill()
        process.exit(0)
      }, 50)
      return json({ ok: true })
    }
    return new Response('not found', { status: 404 })
  },
})

console.log(`relay ready ${socketPath} relayPid=${process.pid} codexPid=${codex.pid}`)

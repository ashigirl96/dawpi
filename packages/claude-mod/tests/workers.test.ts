import { expect, test } from 'claude-code/testing'

const DELEGATE = 'mcp__codex-bridge__delegate'
const WORKER = 'codex-bridge:worker'
const PASSED = 'codex-bridge registered the tool delegate but no tool.call hook answered this call: add on(...)'

type Reply = { ok: boolean; value?: unknown; error?: { code: string; message: string } }

function fakeHost(on: any, options: { hostVerdict?: unknown; bind?: Reply; prepare?: Reply } = {}) {
  const ops: string[] = []
  let stop!: () => void
  const stopped = new Promise<void>(resolve => (stop = resolve))
  let claimed = false
  const model = { calls: 0 }
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-test' }))
  on('tool.register', (_: unknown, e: { name: string }) => ({ value: { tool: `mcp__codex-bridge__${e.name}` } }))
  on('agent.register', (_: unknown, e: { name: string }) => ({ value: { agent: `codex-bridge:${e.name}` } }))
  on('agent.list', () => ({ value: [{ id: 'agent-w', type: WORKER, description: 'w', status: 'running' }] }))
  on('session.messages', () => ({ value: [{ role: 'user', text: 'run_t1', toolUses: [] }] }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('ui.log', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"kind":"ready","version":"0.0.0","pid":1001}\n' }
    await stopped
    return { code: 0, signal: null }
  })
  on('http.fetch', async (_: unknown, e: { url: string; init?: { body?: string } }) => {
    if (e.url.includes('/events')) await stopped
    const body = JSON.parse(e.init?.body ?? '{}')
    ops.push(body.op)
    const reply: Reply = (() => {
      switch (body.op) {
        case 'run.prepare':
          return options.prepare ?? { ok: true, value: { runId: 'run_t1', status: 'prepared', depth: 1 } }
        case 'run.claim':
          if (body.runId !== 'run_t1' || claimed) return { ok: false, error: { code: 'STATE_CONFLICT', message: 'not prepared' } }
          claimed = true
          return { ok: true, value: { runId: body.runId } }
        case 'run.bind':
          return options.bind ?? { ok: true, value: { runId: body.runId, agentId: body.agentId } }
        case 'worker.step':
          return { ok: true, value: { kind: 'report', via: 'text', message: 'Codex Bridge Report for run_t1' } }
        default:
          return { ok: true, value: {} }
      }
    })()
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })
  on('tool.call', { tool: DELEGATE }, () => options.hostVerdict ?? { isError: true, result: PASSED, text: PASSED })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-w' }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    model.calls++
    yield { kind: 'text', index: 0, text: 'model answer' }
    return { turnId: e.turnId, index: e.index, answer: 'model answer', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 1 } }
  })
  return { ops, stop, model }
}

const spawnArgs = (prompt: string) => ({
  tool_use_id: 'toolu_main1',
  prompt,
  description: 'Codex Bridge',
  subagentType: WORKER,
  provider: { plugin: 'codex-bridge', tier: 'user' },
  parentModel: 'haiku',
  permissionMode: 'default',
  background: false,
  fork: false,
})

async function stepOf($: any, agentId: string) {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'haiku', messageCount: 1, agentId })
  for (;;) {
    const piece = await stream.next()
    if (piece.done) return piece.value
  }
}

test('a delegate the host refuses prepares no Run', async ($, on) => {
  const host = fakeHost(on, { hostVerdict: { deny: 'The user denied this call' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await $.tool.call({ tool: DELEGATE, task: { prompt: 'Summarize README.md' } } as any)

  expect(r.deny).toBe('The user denied this call')
  expect(host.ops).not.toContain('run.prepare')
  host.stop()
})

test('a delegate the Supervisor refuses answers the model with the error as text', async ($, on) => {
  const host = fakeHost(on, { prepare: { ok: false, error: { code: 'POLICY_DENIED', message: 'approvalPolicy never needs a user grant' } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await $.tool.call({ tool: DELEGATE, task: { prompt: 'x' }, permissions: { approvalPolicy: 'never' } } as any)

  expect(r.isError).toBe(true)
  expect(typeof r.result).toBe('string')
  expect(String(r.result)).toContain('POLICY_DENIED')
  host.stop()
})

test('a Worker launch whose runId no delegate prepared is denied', async ($, on) => {
  const host = fakeHost(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DELEGATE, task: { prompt: 'Summarize README.md' } } as any)

  const r = await $.agent.spawn(spawnArgs('run_fake') as any)

  expect(typeof r.deny).toBe('string')
  host.stop()
})

test("a bound Worker's Host Step is answered by the Bridge, never by the model", async ($, on) => {
  const host = fakeHost(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DELEGATE, task: { prompt: 'Summarize README.md' } } as any)
  expect((await $.agent.spawn(spawnArgs('run_t1') as any)).agentId).toBe('agent-w')

  const step = await stepOf($, 'agent-w')

  expect(step.answer).toContain('Report for run_t1')
  expect(step.usage).toBe(null)
  expect(host.model.calls).toBe(0)
  host.stop()
})

test('a Worker whose bind failed ends its turn with the error and never reaches the model', async ($, on) => {
  const host = fakeHost(on, { bind: { ok: false, error: { code: 'STATE_CONFLICT', message: 'bind lost' } } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: DELEGATE, task: { prompt: 'Summarize README.md' } } as any)
  await $.agent.spawn(spawnArgs('run_t1') as any)

  const step = await stepOf($, 'agent-w')

  expect(step.answer).toContain('bind lost')
  expect(host.model.calls).toBe(0)
  expect((await $.agent.spawn(spawnArgs('run_t1') as any)).deny).toBeDefined()
  host.stop()
})

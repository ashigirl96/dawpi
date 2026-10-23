import { expect, test } from 'claude-code/testing'

const DIAGNOSE = 'mcp__codex-bridge__diagnose'

function fakeHost(on: any) {
  let spawns = 0
  let stop!: () => void
  const stopped = new Promise<void>(resolve => (stop = resolve))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-test' }))
  on('tool.register', () => ({ value: { tool: DIAGNOSE } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('ui.log', () => ({ value: undefined }))
  on('process.spawn', async function* () {
    spawns++
    const pid = 1000 + spawns
    yield { stream: 'stdout', text: `{"kind":"ready","version":"0.0.0",` }
    yield { stream: 'stdout', text: `"pid":${pid}}\n` }
    await stopped
    return { code: 0, signal: null }
  })
  on('http.fetch', async (_: unknown, e: { url: string }) => {
    if (e.url.includes('/events')) await stopped
    const body = { ok: true, value: { pid: 1000 + spawns, cursor: 1 } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  return { spawns: () => spawns, stop }
}

test('two diagnose calls that arrive together start one Supervisor', async ($, on) => {
  const host = fakeHost(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const [a, b] = await Promise.all([$.tool.call({ tool: DIAGNOSE }), $.tool.call({ tool: DIAGNOSE })])

  expect(host.spawns()).toBe(1)
  expect(JSON.parse(String(a.result)).supervisor.pid).toBe(1001)
  expect(JSON.parse(String(b.result)).supervisor.pid).toBe(1001)
  host.stop()
})

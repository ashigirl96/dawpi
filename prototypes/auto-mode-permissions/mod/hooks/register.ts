// PROTOTYPE (dawpi #15): throwaway. Answers how auto mode judges main's `Agent(cbp15:worker)`
// call (step 2 of the two-step launch) and the worker's doorbell Bash, with and without the
// rules a user can place. No Codex runs here: the worker only rings its doorbell and reports.
import type { Register, EngineInterface, TurnStepResult } from 'claude-code'

const DIR = '/tmp/cbp15'
const VARIANT_FILE = '/tmp/cbp15-variant'
const WORKER = 'cbp15:worker'
const STEP_CAP = 20
const PROBE_CAP = 5
const BELL_DESCRIPTION = 'cbp15 doorbell'

// plain: the Mod leaves main's Agent call to the host.
// hookallow: the Mod's tool.check allows main's Agent call when its prompt is a prepared runId, and the doorbell Bash.
// proto: plain, worded as the prototypes of tickets #13 and #14 were (PROTOTYPE, "never launch it on your own").
// gate: hookallow, but the delegate call itself is left to the host (and so to the classifier), since it carries the task.
type Variant = 'plain' | 'hookallow' | 'proto' | 'gate'
const VARIANTS: readonly Variant[] = ['plain', 'hookallow', 'proto', 'gate']
const modAllows = () => variant === 'hookallow' || variant === 'gate'

// tool.check carries the call's input under `input`; tool.call spreads it onto the event.
const inputOf = (e: any): Record<string, unknown> => e.input ?? e

type Bell = 'none' | 'starting' | 'ran' | 'rung' | 'denied'
type RunState = 'prepared' | 'bound' | 'reported'
type Run = {
  runId: string
  state: RunState
  agentId?: string
  permissionMode?: string
  bell: Bell
  bellPath?: string
  probes: number
  t: Record<string, number>
}

const runs = new Map<string, Run>()
const runByAgent = new Map<string, Run>()
const steps = new Map<string, number>()
let variant: Variant = 'plain'
let stamp = 'nostamp'
let bellDir = `${DIR}/bells`
let mainTurns = 0

let LOG = `${DIR}/log.json`
const entries: unknown[] = []
let flushing = Promise.resolve()
const log = ($: EngineInterface, entry: Record<string, unknown>) => {
  entries.push({ t: Date.now(), ...entry })
  const snapshot = JSON.stringify(entries, null, 2)
  flushing = flushing.then(() => $.fs.write(LOG, snapshot)).catch(() => undefined)
}

// The trial driver polls this file to know when main has settled.
const writeState = ($: EngineInterface) =>
  $.fs.write(`${DIR}/state-${stamp}.json`, JSON.stringify({ mainTurns, runs: [...runs.values()].map(r => ({ runId: r.runId, state: r.state, bell: r.bell })) }))

const rand = () => Math.random().toString(36).slice(2, 10)
const toolUseId = () => `toolu_cbp15${rand()}`

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

// Opening the FIFO read-write never blocks, and closing it gives the doorbell's `cat` its EOF.
const ringBell = ($: EngineInterface, run: Run) => $.process.run(['sh', '-c', `exec 3<>"${run.bellPath}"; echo ring >&3`])

// The Bash call's own tool result mentions task notifications too, so only a completed doorbell's notification counts.
const bellNotified = async ($: EngineInterface, agentId: string) => {
  const api = (await $.session.messages({ agentId, as: 'api' } as any)) as any
  const messages: any[] = Array.isArray(api) ? api : (api?.messages ?? [])
  return messages.some(m => /Background command[^<]*cbp15 doorbell[^<]*completed/.test(JSON.stringify(m.content)))
}

const report = (e: { turnId: string; index: number }, $: EngineInterface, run: Run) => {
  run.state = 'reported'
  run.t.reported = Date.now()
  const message = `cbp15 report ${JSON.stringify({ runId: run.runId, bell: run.bell, probes: run.probes })}`
  const via = run.permissionMode === 'auto' ? 'SubagentHandback' : 'text'
  log($, { ev: 'report', runId: run.runId, via, message })
  void writeState($)
  return via === 'SubagentHandback' ? callTool(e, 'SubagentHandback', { message }) : answerText(e, message)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The variant file holds `<variant> <stamp> <bell dir>`; the driver puts the bell dir under the user's home, as the Bridge would.
    const [v, s, b] = (await $.fs.read(VARIANT_FILE).catch(() => 'plain')).trim().split(/\s+/)
    variant = VARIANTS.find(x => x === v) ?? 'plain'
    stamp = s ?? 'nostamp'
    bellDir = b ?? bellDir
    await $.process.run(['mkdir', '-p', '-m', '700', DIR, bellDir])
    LOG = `/tmp/cbp15-${variant}-${stamp}.json`
    await $.tool.register({
      name: 'delegate',
      description: [
        variant === 'proto'
          ? 'PROTOTYPE (cbp15). Start a Codex delegation chain. Step 1 of 2: this tool prepares a Run and returns its runId.'
          : 'Delegate a task to Codex through the Codex Bridge. Step 1 of 2: this tool prepares a Run and returns its runId.',
        'Step 2: immediately call the Agent tool with subagent_type "cbp15:worker", description "cbp15 d1", and prompt set to exactly the runId, nothing else.',
      ].join(' '),
      inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
      isDeferred: false,
    })
    await $.agent.register({
      name: 'worker',
      description: variant === 'proto'
        ? 'PROTOTYPE Codex worker for cbp15. Never launch it on your own: only as step 2 of mcp__cbp15__delegate, with prompt set to exactly the runId that tool returned.'
        : 'Codex Bridge worker. Launch it only as step 2 of mcp__cbp15__delegate, with prompt set to exactly the runId that tool returned.',
      prompt: 'You are a fallback probe. Reply with exactly the single word FALLBACK and nothing else. Never call tools.',
      tools: ['Agent', 'Bash', 'mcp__cbp15__status'],
      model: 'haiku',
      omitClaudeMd: true,
    })
    await $.tool.register({
      name: 'status',
      description: 'Returns the Codex Bridge Runs as they stand. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    })
    log($, { ev: 'session.start', variant, stamp, permissionMode: (e as any).permissionMode })
    await writeState($)
    return next(e)
  })

  on('tool.call', { tool: /^mcp__cbp15__status$/ }, async () => ({
    result: JSON.stringify([...runs.values()].map(r => ({ runId: r.runId, state: r.state, bell: r.bell }))),
  }))

  on('tool.call', { tool: /^mcp__cbp15__delegate$/ }, async ($, e, next) => {
    // The host's permission check (and so the classifier) runs inside next(); answering without it skips the check.
    if (variant === 'gate') {
      const t0 = Date.now()
      const r: any = await next(e)
      log($, { ev: 'delegate.next', elapsedMs: Date.now() - t0, result: JSON.stringify(r).slice(0, 600) })
      if (/denied|blocked|not allowed|permission/i.test(JSON.stringify(r))) return r
    }
    const run: Run = { runId: `run_${rand()}`, state: 'prepared', bell: 'none', probes: 0, t: { prepared: Date.now() } }
    runs.set(run.runId, run)
    log($, { ev: 'delegate.call', caller: e.agentId ?? 'main', runId: run.runId, task: (e as any).task })
    await writeState($)
    return { result: `Prepared ${run.runId}. Now call the Agent tool with subagent_type "cbp15:worker", description "cbp15 d1", prompt "${run.runId}".` }
  })

  on('tool.check', { tool: /^mcp__cbp15__status$/ }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: /^mcp__cbp15__delegate$/ }, async ($, e, next) => {
    if (variant !== 'gate') return { decision: 'allow' }
    const r = await next(e)
    log($, { ev: 'check.delegate', decision: 'next', task: inputOf(e).task, result: r })
    return r
  })

  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const input = inputOf(e)
    const prepared = runs.get(String(input.prompt ?? '').trim())?.state === 'prepared'
    const mine = e.agentId === undefined && input.subagent_type === WORKER && prepared
    if (modAllows() && mine) {
      log($, { ev: 'check.agent', caller: 'main', decision: 'allow-by-mod', prompt: input.prompt })
      return { decision: 'allow' }
    }
    const r = await next(e)
    log($, { ev: 'check.agent', caller: e.agentId ?? 'main', keys: Object.keys(e), subagentType: input.subagent_type, decision: 'next', result: r })
    return r
  })

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runByAgent.get(e.agentId)
    if (modAllows() && run !== undefined && inputOf(e).command === `cat ${run.bellPath}`) {
      log($, { ev: 'check.bash', caller: e.agentId, decision: 'allow-by-mod' })
      return { decision: 'allow' }
    }
    const r = await next(e)
    log($, { ev: 'check.bash', caller: e.agentId ?? 'main', command: inputOf(e).command, result: r })
    return r
  })

  // tool.call wraps the host's permission check too, so a refused call still reaches here; its result tells.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runByAgent.get(e.agentId)
    const r = await next(e)
    if (run !== undefined && (e as any).command === `cat ${run.bellPath}`) {
      const text = JSON.stringify(r)
      run.bell = /denied|not allowed|permission/i.test(text) ? 'denied' : 'ran'
      run.t.bellCalled = Date.now()
      log($, { ev: 'bell.call', runId: run.runId, bell: run.bell, result: text.slice(0, 600) })
    }
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== WORKER || e.resume !== undefined) return next(e)
    const run = runs.get(e.prompt.trim())
    const why = run === undefined ? 'unknown runId' : run.state !== 'prepared' ? `run is ${run.state}` : e.parentAgentId !== undefined ? 'caller is not main' : undefined
    if (why !== undefined || run === undefined) {
      log($, { ev: 'spawn.deny', reason: why, prompt: e.prompt.slice(0, 200) })
      return { deny: `cbp15:worker refused (${why}).` }
    }
    const r = await next(e)
    if (r.deny !== undefined || r.agentId === undefined) {
      log($, { ev: 'spawn.denied-by-core', runId: run.runId, deny: r.deny })
      return r
    }
    run.agentId = r.agentId
    run.permissionMode = e.permissionMode
    run.state = 'bound'
    run.t.bound = Date.now()
    runByAgent.set(r.agentId, run)
    log($, { ev: 'spawn.bound', runId: run.runId, agentId: r.agentId, permissionMode: e.permissionMode, background: e.background })
    await writeState($)
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id === undefined) return yield* next(e)
    const run = runByAgent.get(id)
    if (run === undefined) {
      const info = (await $.agent.list()).find(a => a.id === id)
      if (!info?.description.startsWith('cbp15')) return yield* next(e)
      log($, { ev: 'step.unbound', agentId: id, index: e.index })
      return yield* answerText(e, 'cbp15: no Run for this worker; refusing to run')
    }
    const n = (steps.get(id) ?? 0) + 1
    steps.set(id, n)
    log($, { ev: 'step.seen', runId: run.runId, index: e.index, n, state: run.state, bell: run.bell })
    if (n > STEP_CAP) return yield* answerText(e, `cbp15: step cap ${STEP_CAP} reached`)
    if (run.state === 'reported') return yield* answerText(e, `cbp15 ${run.runId}: already reported`)

    if (run.bell === 'none') {
      run.bell = 'starting'
      run.bellPath = `${bellDir}/bell-${run.runId}`
      await $.process.run(['mkfifo', '-m', '600', run.bellPath])
      run.t.bellStart = Date.now()
      log($, { ev: 'bell.start', runId: run.runId })
      return yield* callTool(e, 'Bash', { command: `cat ${run.bellPath}`, description: BELL_DESCRIPTION, run_in_background: true })
    }
    if (run.bell === 'starting' || run.bell === 'denied') {
      log($, { ev: 'bell.not-running', runId: run.runId, bell: run.bell })
      return yield* report(e, $, run)
    }
    if (run.bell === 'ran') {
      await ringBell($, run)
      run.bell = 'rung'
      run.t.bellRung = Date.now()
      log($, { ev: 'bell.rung', runId: run.runId })
    }
    // Stopping while only the doorbell is live sends the caller an interim notification, so take Host Steps until it lands.
    if (run.bell === 'rung' && !(await bellNotified($, id)) && run.probes < PROBE_CAP) {
      run.probes++
      return yield* callTool(e, 'mcp__cbp15__status', {})
    }
    return yield* report(e, $, run)
  }).catch(async function* ($, e, next) {
    log($, { ev: 'step.caught', agentId: e.agentId, index: e.index, error: String(next.error?.message ?? next.error) })
    return yield* answerText(e, `cbp15 error: ${next.error.message}`)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurns++
      log($, { ev: 'main.turn.complete', n: mainTurns, reason: e.reason, answer: e.answer })
      await writeState($)
    } else if (runByAgent.has(e.agentId)) {
      log($, { ev: 'worker.turn.complete', runId: runByAgent.get(e.agentId)!.runId, reason: e.reason, answer: e.answer, usage: e.usage ?? null })
    }
    return next(e)
  })
}

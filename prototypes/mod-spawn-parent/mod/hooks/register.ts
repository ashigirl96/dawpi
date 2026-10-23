// PROTOTYPE (dawpi #2): throwaway. Answers whether agents spawned from a tool.call
// hook get the calling agent as parent, and which hooks still see the children.
import type { Register, EngineInterface, TurnStepResult } from 'claude-code'

const LOG = '/tmp/cbproto-log.json'
const START = 'mcp__cbproto__start'
const DISPATCH = 'mcp__cbproto__dispatch'
const WORKER = 'cbproto:worker'
const MAX_DISPATCH_DEPTH = 3

type Mode = 'tree' | 'agent-tool' | 'throw' | 'throw-catch'
type Worker = { depth: number; mode: Mode }

const entries: unknown[] = []
const spawnedVia = new Set<string>()
let flushing = Promise.resolve()
const log = ($: EngineInterface, entry: Record<string, unknown>) => {
  entries.push({ t: Date.now(), ...entry })
  const snapshot = JSON.stringify(entries, null, 2)
  flushing = flushing.then(() => $.fs.write(LOG, snapshot)).catch(() => undefined)
}

const workerOf = async ($: EngineInterface, agentId: string | undefined): Promise<Worker | undefined> => {
  if (agentId === undefined) return undefined
  const info = (await $.agent.list()).find(a => a.id === agentId)
  const m = info?.description.match(/^cbproto d(\d+) (\S+)$/)
  return m ? { depth: Number(m[1]), mode: m[2] as Mode } : undefined
}

const spawnWorker = async ($: EngineInterface, depth: number, mode: Mode) => {
  const spawned = await $.agent.spawn({
    subagentType: WORKER,
    description: `cbproto d${depth} ${mode}`,
    prompt: 'cbproto scripted worker',
  })
  const child = spawned.agentId === undefined
    ? undefined
    : (await $.agent.list()).find(a => a.id === spawned.agentId)
  return { spawned, child }
}

const toolUseId = () => `toolu_cbproto${Math.random().toString(36).slice(2, 12)}`

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'start',
      description: 'PROTOTYPE probe. Spawns a scripted cbproto worker tree. mode: tree | agent-tool | throw | throw-catch.',
      inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['tree', 'agent-tool', 'throw', 'throw-catch'] } }, required: ['mode'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list',
      description: 'PROTOTYPE probe. Returns $.agent.list() as it stands now.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'dispatch',
      description: 'PROTOTYPE probe. Spawns one child cbproto worker under the calling worker.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.agent.register({
      name: 'worker',
      description: 'PROTOTYPE probe worker; spawned by the cbproto mod only.',
      prompt: 'You are a fallback probe. Reply with exactly the single word FALLBACK and nothing else. Never call tools.',
      tools: [DISPATCH, 'Agent'],
      model: 'haiku',
      omitClaudeMd: true,
    })
    log($, { ev: 'session.start' })
    return next(e)
  })

  on('tool.check', { tool: START }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: DISPATCH }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: 'Agent' }, async ($, e, next) =>
    (await workerOf($, e.agentId)) ? { decision: 'allow' } : next(e))

  on('tool.call', { tool: 'mcp__cbproto__list' }, async $ => ({ result: JSON.stringify(await $.agent.list()) }))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (e.description.startsWith('cbproto')) {
      log($, { ev: 'agent.spawn', description: e.description, parentAgentId: e.parentAgentId ?? null, resume: e.resume ?? null, origin: next.origin, result: r })
    }
    return r
  })

  on('tool.call', { tool: START }, async ($, e) => {
    const mode = String(e.mode) as Mode
    const { spawned, child } = await spawnWorker($, 1, mode)
    log($, { ev: 'start.spawned', caller: e.agentId ?? 'main', mode, spawned, child })
    return { result: JSON.stringify({ spawned, child }) }
  })

  // Three separate registrations: a child skips the hook that spawned it, so
  // the log shows which registration each depth's call reaches.
  for (const slot of [1, 2, 3]) {
    on('tool.call', { tool: DISPATCH }, async ($, e) => {
      const caller = await workerOf($, e.agentId)
      log($, { ev: 'dispatch.seen', slot, caller: e.agentId ?? 'main', callerDepth: caller?.depth })
      const depth = (caller?.depth ?? 0) + 1
      const { spawned, child } = await spawnWorker($, depth, caller?.mode ?? 'tree')
      log($, { ev: 'dispatch.spawned', slot, caller: e.agentId ?? 'main', depth, spawned, child })
      return { result: JSON.stringify({ slot, depth, spawned, childParentId: child?.parentId }) }
    })
  }

  on('turn.step', async function* ($, e, next) {
    const w = await workerOf($, e.agentId)
    if (w === undefined) return yield* next(e)
    log($, { ev: 'step.seen', agentId: e.agentId, depth: w.depth, mode: w.mode, index: e.index, model: e.model })
    if (w.mode === 'throw' || w.mode === 'throw-catch') throw new Error(`cbproto: deliberate failure (${w.mode})`)
    if (e.index === 0 && w.depth <= MAX_DISPATCH_DEPTH && w.mode === 'tree') return yield* callTool(e, DISPATCH, {})
    // A background child's end resumes its parent at index 0 again, so spawn once per agent, not per index.
    if (w.mode === 'agent-tool' && w.depth <= MAX_DISPATCH_DEPTH && e.agentId !== undefined && !spawnedVia.has(e.agentId)) {
      spawnedVia.add(e.agentId)
      return yield* callTool(e, 'Agent', {
        subagent_type: WORKER,
        description: `cbproto d${w.depth + 1} agent-tool`,
        prompt: 'cbproto scripted worker',
      })
    }
    return yield* answerText(e, `cbproto d${w.depth} done`)
  }).catch(async function* ($, e, next) {
    const w = await workerOf($, e.agentId)
    log($, { ev: 'step.caught', agentId: e.agentId, mode: w?.mode, index: e.index, error: next.error })
    // Returning nothing is the hook absent, as if it had no .catch at all.
    if (w?.mode !== 'throw-catch') return
    return yield* answerText(e, `cbproto error: ${next.error.message}`)
  })

  on('turn.complete', async ($, e, next) => {
    const w = await workerOf($, e.agentId)
    if (w !== undefined) {
      const self = (await $.agent.list()).find(a => a.id === e.agentId)
      log($, { ev: 'turn.complete', agentId: e.agentId, depth: w.depth, mode: w.mode, reason: e.reason, answer: e.answer, usage: e.usage ?? null, self })
    }
    return next(e)
  })
}

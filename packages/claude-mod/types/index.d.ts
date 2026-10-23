export type SupervisorSnapshot = {
  phase: 'absent' | 'starting' | 'running' | 'exited'
  cursor: number
  pid?: number | undefined
  version?: string | undefined
  lastEvent?: { seq: number; kind: string; observedAt: string } | undefined
  exit?: { code: number | null; signal: string | null } | undefined
}

declare module 'claude-code' {
  interface PluginState {
    'codex-bridge': { supervisor: SupervisorSnapshot }
  }
}

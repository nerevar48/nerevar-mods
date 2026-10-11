export type TokenUsage = {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

// Everything counted since the session began; kept in $.store under the
// session id, so a resume or an app relaunch continues the same totals.
export type SessionTotals = {
  sessionId: string
  turns: number
  workMs: number
  lastTurnMs: number
  main: TokenUsage
  agents: TokenUsage
  // Percentage points of each rate-limit window spent during this session's turns.
  quotaSpent: Record<string, number>
}

declare module 'claude-code' {
  interface PluginState {
    'turn-stats': { totals: SessionTotals | null; runningSince: number | null }
  }
}

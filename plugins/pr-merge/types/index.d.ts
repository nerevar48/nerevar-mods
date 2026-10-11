export type Checks = { passed: number; failed: number; pending: number }

export type Pr = {
  number: number
  title: string
  base: string
  head: string
  headSha: string
  isDraft: boolean
  hasConflicts: boolean
  checks: Checks
}

// resolving: Claude merges the base into the branch and fixes conflicts in its own turn.
export type Phase = 'idle' | 'confirm' | 'resolving' | 'merging'

declare module 'claude-code' {
  interface PluginState {
    'pr-merge': { pr: Pr | null; phase: Phase }
  }
}

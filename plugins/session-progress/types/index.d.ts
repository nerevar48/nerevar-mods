export type PlanSource = 'tool' | 'todo' | 'tasks'

export type Plan = {
  title: string
  steps: string[]
  done: number
  total: number
  /** The step in progress, a few words; empty when none is. */
  current: string
  isFinished: boolean
  source: PlanSource
}

export type TaskItem = {
  id: string
  subject: string
  activeForm: string
  status: 'pending' | 'in_progress' | 'completed'
}

declare module 'claude-code' {
  interface PluginState {
    'session-progress': { plan: Plan | null; tasks: TaskItem[] }
  }
}

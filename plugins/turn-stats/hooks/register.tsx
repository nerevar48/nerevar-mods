// Session statistics band: the desktop Code tab does not show a Stop hook's
// systemMessage, so the session's totals are drawn above the prompt instead.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, RenderElement, RenderNode, SessionRateLimit } from 'claude-code'

import type { SessionTotals, TokenUsage } from '../types'

const totals = atom({ plugin: 'turn-stats', key: 'totals' } as const, null)
const runningSince = atom({ plugin: 'turn-stats', key: 'runningSince' } as const, null)

// The band is shared, and the engine chains mods in no fixed order: each mod
// files its section under a rank (time 10, PR 20, progress 30), the sections
// beneath come up as one column, and the column is kept sorted by rank, the
// rest (core's own drawing) last.
const COLUMN = 'band-sections'
const SECTION = 'band-section:'
const RANK = 10

function rankOf(node: RenderNode): number {
  const key = typeof node === 'object' && node.type === 'Box' ? node.props?.key : undefined
  const rank = typeof key === 'string' && key.startsWith(SECTION) ? Number(key.slice(SECTION.length)) : NaN
  return Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER
}

function stacked(below: RenderElement, section: RenderElement): RenderElement {
  const rest = below.type === 'Box' && below.props?.key === COLUMN ? (below.children ?? []) : [below]
  const children = [section, ...rest].sort((a, b) => rankOf(a) - rankOf(b))
  return { type: 'Box', props: { key: COLUMN, flexDirection: 'column' }, children }
}

const STORE_PREFIX = 'session:'
const MAX_STORED_SESSIONS = 200
const SEPARATOR = ' · '

// One styled run of the stats row; the row is a line of runs.
type Part = { text: string; color?: string; isDim?: boolean; isBold?: boolean }

// A dim label and its value in the figure's color: "вх 213.8k".
const labelled = (label: string, value: string, color: string): Part[] => [
  { text: `${label} `, isDim: true },
  { text: value, color },
]

const QUOTA_LABELS: [kind: string, label: string][] = [
  ['five_hour', '5ч'],
  ['seven_day', 'W'],
]

function trim(n: number, digits: number): string {
  return String(Number(n.toFixed(digits)))
}

// Thresholds sit where rounding would otherwise print "1000k" or "1000".
function formatTokens(n: number): string {
  if (n >= 999_950) return trim(n / 1e6, 2) + 'M'
  if (n >= 999.5) return trim(n / 1e3, 1) + 'k'
  return String(Math.round(n))
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (v: number) => String(v).padStart(2, '0')
  if (hours > 0) return `${hours}ч${pad(minutes)}м`
  if (minutes > 0) return `${minutes}м${pad(seconds)}с`
  return `${seconds}с`
}

const emptyTokens = (): TokenUsage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })

const freshTotals = (sessionId: string): SessionTotals => ({
  sessionId,
  turns: 0,
  workMs: 0,
  lastTurnMs: 0,
  main: emptyTokens(),
  agents: emptyTokens(),
  quotaSpent: {},
})

const addTokens = (sum: TokenUsage, u: ModelUsage): TokenUsage => ({
  input: sum.input + u.input_tokens,
  cacheWrite: sum.cacheWrite + u.cache_creation_input_tokens,
  cacheRead: sum.cacheRead + u.cache_read_input_tokens,
  output: sum.output + u.output_tokens,
})

const tokenTotal = (u: TokenUsage) => u.input + u.cacheWrite + u.cacheRead + u.output

// Percentage points each window grew by over one turn. A window that reset
// mid-turn counts its whole new reading.
function quotaSpend(before: SessionRateLimit[], after: SessionRateLimit[]): Record<string, number> {
  const spent: Record<string, number> = {}
  for (const now of after) {
    const was = before.find(l => l.kind === now.kind)
    if (!was) continue
    const delta = was.resetsAt === now.resetsAt ? now.percentUsed - was.percentUsed : now.percentUsed
    if (delta > 0) spent[now.kind] = delta
  }
  return spent
}

function addSpent(sum: Record<string, number>, spent: Record<string, number>): Record<string, number> {
  const result = { ...sum }
  for (const [kind, delta] of Object.entries(spent)) result[kind] = (result[kind] ?? 0) + delta
  return result
}

const storeKey = (sessionId: string) => STORE_PREFIX + sessionId

function isTotals(value: unknown, sessionId: string): value is SessionTotals {
  return typeof value === 'object' && value !== null && (value as SessionTotals).sessionId === sessionId
}

async function loadTotals($: EngineInterface, sessionId: string): Promise<SessionTotals | null> {
  const stored = await $.store.get(storeKey(sessionId))
  return isTotals(stored, sessionId) ? stored : null
}

// Applies `change` to this session's totals and persists the result, so a
// resumed session or a relaunched app keeps counting from where it stopped.
async function record($: EngineInterface, change: (t: SessionTotals) => SessionTotals): Promise<void> {
  const sessionId = await $.session.id()
  const current = await read($, totals)
  const seed = current?.sessionId === sessionId ? null : await loadTotals($, sessionId)
  const next = await update($, totals, t =>
    change(t?.sessionId === sessionId ? t : (seed ?? freshTotals(sessionId))),
  )
  await $.store.set(storeKey(sessionId), next)
}

export const register: Register = on => {
  // The main loop runs one turn at a time; a hot reload mid-turn only drops
  // that turn's quota delta and live ticking, never its time or tokens.
  let turnBefore: { turnId: string; limits: SessionRateLimit[] } | null = null
  let ticker: { cancel: () => void } | null = null
  const stopTicker = () => {
    ticker?.cancel()
    ticker = null
  }

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const sessionId = await $.session.id()
    if ((await read($, totals))?.sessionId !== sessionId) {
      const stored = await loadTotals($, sessionId)
      await update($, totals, () => stored)
    }
    await update($, runningSince, () => null)

    const keys = (await $.store.keys()).filter(k => k.startsWith(STORE_PREFIX))
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STORED_SESSIONS))) {
      await $.store.delete(key)
    }
    return result
  })

  // /clear goes on under a new session id with no session.start: start over.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      stopTicker()
      turnBefore = null
      await update($, totals, () => null)
      await update($, runningSince, () => null)
    }
    return next(e)
  })

  // turn.start is raised for the main loop only; subagent runs carry agentId on turn.complete.
  on('turn.start', async ($, e, next) => {
    turnBefore = { turnId: e.turnId, limits: (await $.session.usage()).rateLimits }
    const startedAt = await $.clock.now()
    await update($, runningSince, () => startedAt)
    stopTicker()
    ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (e.agentId) {
      if (usage) await record($, t => ({ ...t, agents: addTokens(t.agents, usage) }))
      return result
    }

    stopTicker()
    const before = turnBefore?.turnId === e.turnId ? turnBefore.limits : null
    turnBefore = null
    const spent = before ? quotaSpend(before, (await $.session.usage()).rateLimits) : {}
    await record($, t => ({
      ...t,
      turns: t.turns + 1,
      workMs: t.workMs + e.durationMs,
      lastTurnMs: e.durationMs,
      main: usage ? addTokens(t.main, usage) : t.main,
      quotaSpent: addSpent(t.quotaSpent, spent),
    }))
    await update($, runningSince, () => null)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const session = await read($, totals)
    const since = await read($, runningSince)
    const liveMs = e.props.isWorking && since !== null ? Math.max(0, (await $.clock.now()) - since) : null
    if (e.props.hasSurvey || (session === null && liveMs === null)) {
      return next(e)
    }

    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const { rateLimits } = await $.session.usage()
    const segments: Part[][] = []

    const workMs = (session?.workMs ?? 0) + (liveMs ?? 0)
    const turnMs = liveMs ?? (session !== null && session.turns > 0 ? session.lastTurnMs : null)
    segments.push([
      { text: '⏱ ', isDim: true },
      { text: formatDuration(workMs), isBold: true },
      ...(turnMs !== null ? [{ text: ` (ход ${formatDuration(turnMs)})`, isDim: true }] : []),
    ])

    if (session !== null) {
      const { main, agents } = session
      if (tokenTotal(main) + tokenTotal(agents) > 0) {
        segments.push(labelled('вх', formatTokens(main.input + main.cacheWrite + agents.input + agents.cacheWrite), 'cyan'))
        segments.push(labelled('вых', formatTokens(main.output + agents.output), 'green'))
        segments.push(labelled('кэш', formatTokens(main.cacheRead + agents.cacheRead), 'blue'))
        if (tokenTotal(agents) > 0) segments.push(labelled('агенты', formatTokens(tokenTotal(agents)), 'magenta'))
      }
    }

    const quotas: Part[] = []
    for (const [kind, label] of QUOTA_LABELS) {
      const limit = rateLimits.find(l => l.kind === kind)
      if (!limit) continue
      const spent = session?.quotaSpent[kind] ?? 0
      if (quotas.length > 0) quotas.push({ text: ' ' })
      quotas.push(...labelled(label, `${trim(limit.percentUsed, 1)}%`, 'yellow'))
      if (spent >= 0.05) quotas.push({ text: ` +${trim(spent, 1)}`, isDim: true })
    }
    if (quotas.length > 0) segments.push(quotas)

    const parts = segments.flatMap((segment, i) => (i === 0 ? segment : [{ text: SEPARATOR, isDim: true }, ...segment]))

    return stacked(
      below,
      <Box key={`${SECTION}${RANK}`} flexDirection="column">
        <Text wrap="truncate-end">
          {parts.map(part => (
            <Text color={part.color} dimColor={part.isDim} bold={part.isBold}>
              {part.text}
            </Text>
          ))}
        </Text>
      </Box>,
    )
  })
}

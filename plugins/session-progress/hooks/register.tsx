import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register } from 'claude-code'

import type { Plan, TaskItem } from '../types'

const plan = atom({ plugin: 'session-progress', key: 'plan' } as const, null)
const tasks = atom({ plugin: 'session-progress', key: 'tasks' } as const, [])

const TOOL = 'mcp__session-progress__progress'

const RULE =
  '# Progress bar\n' +
  `The user follows the task through a progress bar above the prompt, drawn by the \`${TOOL}\` tool. ` +
  'When a request takes more than a couple of tool calls (investigating, editing several files, running checks, committing), ' +
  'call it before the work starts, with a short title and the planned steps; call it again as each step finishes, ' +
  'and once more with finished: true when the task is done. ' +
  'A routine-looking task still gets the bar; only a direct answer or a single edit goes without it. ' +
  'When TodoWrite or TaskCreate/TaskUpdate already track the work, the bar follows that list instead.'

// Prompts that report on work rather than ask for it. A denylist: the desktop's
// own prompts may arrive unstamped, and an engine without origins stamps none.
const REPORTS = new Set<PromptOrigin['kind']>(['task-notification', 'peer-send-message', 'observer', 'observer-activity'])

const asksForWork = (origin: PromptOrigin | undefined): boolean =>
  !origin || (origin.kind === 'plugin' ? origin.asUser === true : !REPORTS.has(origin.kind))

const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  steps?: string[]
  done?: number
  current?: string
  finished?: boolean
}

type TodoInput = { todos?: { content?: string; status?: string; activeForm?: string }[] }

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else
// the process locale; English when nothing says Russian.

type Lang = 'en' | 'ru'

const STRINGS = {
  en: { title: 'Current task', done: 'Done', planning: 'Plan' },
  ru: { title: 'Текущая задача', done: 'Готово', planning: 'План' },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isRussian(settings.language) ? 'ru' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isRussian(locale) ? 'ru' : 'en'
}

// ---------------------------------------------------------------------------
// The plan, from whichever source spoke last.

const clean = (s: unknown): string => (typeof s === 'string' ? s.trim() : '')

const blank = (): Plan => ({ title: tr().title, steps: [], done: 0, total: 0, current: '', isFinished: false, source: 'tool' })

// A todo list or the task list keeps the title of the plan it continues.
const titleFor = (prev: Plan | null): string => (prev && !prev.isFinished ? prev.title : tr().title)

const fromTool = (prev: Plan | null, input: ProgressInput): Plan => {
  const title = clean(input.title)
  const isNew = !prev || prev.isFinished || (title !== '' && title !== prev.title)
  const base = isNew || !prev ? blank() : prev
  const steps = input.steps?.map(clean).filter(Boolean) ?? base.steps
  const total = input.steps ? steps.length : base.total
  const done = Math.min(total, Math.max(0, Math.round(input.done ?? base.done)))
  // Moving `done` without naming the step points `current` at the next planned one.
  const current =
    input.current !== undefined ? clean(input.current) : done !== base.done ? steps[done] ?? '' : base.current
  const isFinished = input.finished === true
  return {
    title: title || base.title,
    steps,
    total,
    done: isFinished ? total : done,
    current: isFinished ? '' : current,
    isFinished,
    source: 'tool',
  }
}

const fromList = (
  prev: Plan | null,
  items: { title: string; active: string; status: string }[],
  source: Plan['source'],
): Plan | null => {
  if (!items.length) {
    // An emptied list closes the plan it drew; anything else stays as it is.
    return prev && prev.source === source && !prev.isFinished ? { ...prev, done: prev.total, current: '', isFinished: true } : prev
  }
  const done = items.filter(i => i.status === 'completed').length
  const active = items.find(i => i.status === 'in_progress')
  return {
    title: titleFor(prev),
    steps: items.map(i => i.title),
    total: items.length,
    done,
    current: active ? active.active || active.title : '',
    isFinished: done === items.length,
    source,
  }
}

const fromTasks = (prev: Plan | null, list: TaskItem[]): Plan | null =>
  fromList(prev, list.map(t => ({ title: t.subject, active: t.activeForm, status: t.status })), 'tasks')

const ratio = (p: Plan): number => (p.isFinished ? 1 : p.total ? p.done / p.total : 0)

const label = (p: Plan): string => (p.isFinished ? tr().done : p.total ? `${p.done}/${p.total}` : tr().planning)

// ---------------------------------------------------------------------------
// The row, drawn as savvy-progress draws its band: one SVG, since the desktop
// wraps sibling elements onto new lines.

const H = 22
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Rough advance of system UI text, in em; good enough to size a text slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// Pixel Clawd: it walks while a turn runs.
const CLAY = '#D97757'
const INK = '#1F1E1D'

const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const crab = (x: number, isWalking: boolean): string => {
  const r = (cx: number, cy: number, w: number, h: number, c: string) =>
    `<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`
  const body = r(7, 10, 16, 12, CLAY) + r(3, 14, 4, 4, CLAY) + r(23, 14, 4, 4, CLAY) + r(9, 12, 2, 2, INK) + r(19, 12, 2, 2, INK)
  const legsA = r(7, 22, 2, 4, CLAY) + r(17, 22, 2, 4, CLAY)
  const legsB = r(11, 22, 2, 4, CLAY) + r(21, 22, 2, 4, CLAY)
  return `<g transform="translate(${x},0) scale(0.8)" shape-rendering="crispEdges"><g${isWalking ? ' class="run"' : ''}><g class="bd">${body}</g><g class="la">${legsA}</g><g class="lb">${legsB}</g></g></g>`
}

const rowSvg = (p: Plan, W: number, isWorking: boolean): string => {
  // Title and the step in progress share up to 45% of the row; the bar takes the rest.
  const title = fitText(p.title, 13, Math.max(60, W * 0.25))
  const titleW = textWidth(title, 13)
  const current = p.current ? fitText(p.current, 12, Math.max(0, W * 0.45 - titleW - 14)) : ''
  const currentX = 16 + titleW + 8
  const BAR_X = Math.round(current ? currentX + textWidth(current, 12) + 12 : 16 + titleW + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = p.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(p))
  // The step in progress: a faint second layer up to its end.
  const runW = p.total && p.current && !p.isFinished ? Math.round((BAR_W * Math.min(p.total, p.done + 1)) / p.total) : 0
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)

  // Dithered fill: sparse at the start, dense toward the head.
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }
  const ticks: string[] = []
  for (let i = 1; i < p.total; i++) {
    const x = Math.round((BAR_W * i) / p.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(p)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(p) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${p.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${p.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${p.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${p.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${p.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
${current ? `<text class="m" x="${currentX}" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="12">${xml(current)}</text>` : ''}
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, isWorking && !p.isFinished)}
</svg>`
}

const barText = (p: Plan, width: number): string => {
  const filled = Math.round(width * ratio(p))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    await $.tool.register({
      name: 'progress',
      isDeferred: false,
      // Not deferred: the model reads this description in every session, so it carries the rule.
      description:
        'Shows the user how far along the current task is, as a progress bar above the prompt. ' +
        'When a request takes more than a couple of tool calls, call it once the plan is clear (title, steps), ' +
        'again as each step finishes (done; current names the step now in progress), and once at the end with finished: true. ' +
        'If you track the work with TodoWrite or TaskCreate/TaskUpdate, the bar follows that list and this tool is not needed. ' +
        'Skip it for quick answers and single edits. Fields left out keep their previous value; a new title starts a new plan. ' +
        'Cheap and silent: it only draws the bar.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the task, a few words.' },
          steps: { type: 'array', items: { type: 'string' }, description: 'The planned steps in order, a few words each.' },
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          current: { type: 'string', description: 'The step now in progress, a few words; defaults to the next planned step.' },
          finished: { type: 'boolean', description: 'True once the task is complete.' },
        },
      },
    })
    return started
  })

  // The tool description alone reads as optional, and the model skips it: each
  // prompt carries the rule beside it, where the model plans the work.
  on('prompt.submit', ($, e, next) =>
    asksForWork(e.origin) ? next({ ...e, context: [...(e.context ?? []), RULE] }) : next(e),
  )

  // A new main-loop turn hides a finished bar; the next plan starts clean.
  on('turn.start', async ($, e, next) => {
    const p = await read($, plan)
    if (p?.isFinished) {
      await update($, plan, () => null)
      await update($, tasks, () => [])
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: the bar follows the main session only' }
    const p = await update($, plan, prev => fromTool(prev, e as unknown as ProgressInput))
    return { result: `ok: ${p ? label(p) : ''}` }
  })

  // Subagents keep lists of their own: only the main loop's list moves the bar.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    const items = ((e as unknown as TodoInput).todos ?? [])
      .map(t => ({ title: clean(t.content), active: clean(t.activeForm), status: clean(t.status) }))
      .filter(t => t.title)
    await update($, plan, prev => fromList(prev, items, 'todo'))
    return result
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    const id = clean(result.result?.task?.id)
    if (!id) return result
    const list = await update($, tasks, (prev): TaskItem[] => [
      ...prev.filter(t => t.id !== id),
      { id, subject: clean(e.subject), activeForm: clean(e.activeForm), status: 'pending' },
    ])
    await update($, plan, prev => fromTasks(prev, list))
    return result
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError || !result.result?.success) return result
    const id = clean(e.taskId)
    const list = await update($, tasks, (prev): TaskItem[] =>
      e.status === 'deleted'
        ? prev.filter(t => t.id !== id)
        : prev.map(t =>
            t.id !== id
              ? t
              : {
                  ...t,
                  subject: clean(e.subject) || t.subject,
                  activeForm: clean(e.activeForm) || t.activeForm,
                  status: e.status && e.status !== 'deleted' ? e.status : t.status,
                },
          ),
    )
    await update($, plan, prev => fromTasks(prev, list))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, plan)
    if (p === null || e.props.hasSurvey) return next(e)

    // The band is shared: draw our row above whatever the plugins beneath draw,
    // parted from them by a rule; core's own drawing ('engine') gets none.
    const below = await next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const rule = below.type !== 'engine' && (
      <Text dimColor wrap="truncate-end">
        {'─'.repeat(e.props.bodyColumns)}
      </Text>
    )
    const percent = `${Math.round(ratio(p) * 100)}%`
    const dismiss = <Button key="session-progress-dismiss" label="✕" plain role="dismiss" onPress={() => update($, plan, () => null)} />

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the dismiss and its gap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 48))
      const alt = `${p.title}${p.current ? ` · ${p.current}` : ''}: ${label(p)}, ${percent}`
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={rowSvg(p, width, e.props.isWorking)} alt={alt} width={width} height={H} />
            {dismiss}
          </Box>
          {rule}
          {below}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const head = p.current ? `${p.title} · ${p.current}` : p.title
    const titleW = Math.max(8, Math.min(40, head.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 24))
    const color = p.isFinished ? DONE : ACCENT
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Box width={titleW} flexShrink={0}>
            <Text color={color}>● </Text>
            <Text wrap="truncate-end">
              {p.title}
              {p.current ? <Text dimColor> · {p.current}</Text> : ''}
            </Text>
          </Box>
          <Text color={color}>{barText(p, width)}</Text>
          <Text bold>{label(p)}</Text>
          <Text dimColor>{percent}</Text>
          {dismiss}
        </Box>
        {rule}
        {below}
      </Box>
    )
  })
}

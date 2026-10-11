import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement, SessionRateLimit, TurnUsage } from 'claude-code'

const SESSION = 'session-a'
const SURFACES = ['terminal', 'desktop'] as const

type World = { limits: SessionRateLimit[]; below?: string }

// The engine beneath the plugin: a session id, usage figures the test moves,
// a mocked clock, a store the test can read, and bottoms for passed-on events.
function engine(on: On, world: World, store = new Map<string, unknown>()) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: SESSION }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000 },
      rateLimits: world.limits,
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('ui.invalidate', () => ({ value: undefined }))
  // What the plugins beneath draw: an empty box, or a row of text (another band).
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (world.below === undefined ? h(Box, { key: 'engine' }) : h(Text, {}, world.below)) as RenderElement
  })
  return clock
}

const usage = (input: number, cacheRead: number, output: number, cacheWrite = 0): TurnUsage => ({
  model: 'claude-opus-5-5',
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
})

async function turn($: Engine, turnId: string, durationMs: number, used?: TurnUsage, agentId?: string) {
  if (!agentId) await $.turn.start({ text: 'go', turnId })
  await $.turn.complete({
    answer: '',
    durationMs,
    isAborted: false,
    turnId,
    reason: 'answer',
    ...(agentId ? { agentId } : {}),
    ...(used ? { usage: used } : {}),
  })
}

function band($: Engine, surface: (typeof SURFACES)[number], isWorking = false) {
  return $.ui.mount({
    plugin: 'turn-stats',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
}

// The stats row is one Text of styled runs; a row drawn beneath it follows after ' | '.
async function shown(ui: Awaited<ReturnType<typeof band>>): Promise<string> {
  const [row, ...rest] = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  return [row, ...rest.filter(text => !row.includes(text))].join(' | ')
}

// The style of the run showing exactly `text`.
async function styleOf(ui: Awaited<ReturnType<typeof band>>, text: string) {
  return (await ui.findAll({ type: 'Text' })).find(t => t.text === text)?.props
}

describe('turn-stats', () => {
  for (const surface of SURFACES) {
    test(`${surface}: work time adds up over the session, the last turn shown beside it`, async ($, on) => {
      engine(on, { limits: [] })
      await turn($, 't1', 61_000)
      await turn($, 't2', 5_000)
      const text = await shown(await band($, surface))
      expect(text).toBe('⏱ 1м06с (ход 5с)')
    })

    test(`${surface}: tokens of every turn and every subagent count, background ones included`, async ($, on) => {
      engine(on, { limits: [] })
      await turn($, 't1', 1_000, usage(1_000, 10_000, 500, 2_000))
      await turn($, 'a1', 1_000, usage(100, 1_000, 100), 'agent-1')
      // A background subagent finishing between turns is not dropped by the next turn.
      await turn($, 't2', 1_000, usage(1_000, 20_000, 500))
      const text = await shown(await band($, surface))
      expect(text).toBe('⏱ 2с (ход 1с) · вх 4.1k · вых 1.1k · кэш 31k · агенты 1.2k')
    })

    test(`${surface}: labels are dim and each figure has its own color`, async ($, on) => {
      engine(on, { limits: [{ kind: 'five_hour', percentUsed: 8, resetsAt: 'A' }] })
      await turn($, 't1', 1_000, usage(1_000, 10_000, 500))
      await turn($, 'a1', 1_000, usage(100, 0, 0), 'agent-1')
      const ui = await band($, surface)
      expect(await styleOf(ui, 'вх ')).toMatchObject({ dimColor: true })
      expect((await styleOf(ui, '1.1k'))?.color).toBe('cyan')
      expect((await styleOf(ui, '500'))?.color).toBe('green')
      expect((await styleOf(ui, '10k'))?.color).toBe('blue')
      expect((await styleOf(ui, '100'))?.color).toBe('magenta')
      expect((await styleOf(ui, '8%'))?.color).toBe('yellow')
    })

    test(`${surface}: the quota shows what this session's turns spent`, async ($, on) => {
      const week = { kind: 'seven_day', percentUsed: 18, resetsAt: 'W' }
      const world: World = { limits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: 'A' }, week] }
      engine(on, world)
      await $.turn.start({ text: 'go', turnId: 't1' })
      world.limits = [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: 'A' }, week]
      await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
      // Another session's use between turns is not this session's.
      world.limits = [{ kind: 'five_hour', percentUsed: 50, resetsAt: 'A' }, week]
      await $.turn.start({ text: 'go', turnId: 't2' })
      // The window resets mid-turn: the new reading is this turn's at most.
      world.limits = [{ kind: 'five_hour', percentUsed: 1, resetsAt: 'B' }, { ...week, percentUsed: 18.4 }]
      await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
      const text = await shown(await band($, surface))
      expect(text).toBe('⏱ 0с (ход 0с) · 5ч 1% +3.5 W 18.4% +0.4')
    })

    test(`${surface}: a running turn ticks live on top of the session total`, async ($, on) => {
      const clock = engine(on, { limits: [] })
      await turn($, 't1', 10_000)
      await $.turn.start({ text: 'go', turnId: 't2' })
      await clock.advance(3_000)
      const text = await shown(await band($, surface, true))
      expect(text).toBe('⏱ 13с (ход 3с)')
    })

    test(`${surface}: the band beneath (another plugin's) still shows under the stats`, async ($, on) => {
      engine(on, { limits: [], below: 'PR #40' })
      await turn($, 't1', 2_000)
      const text = await shown(await band($, surface))
      expect(text).toBe('⏱ 2с (ход 2с) | PR #40')
    })
  }

  test('totals are written to the store under the session id', async ($, on) => {
    const store = new Map<string, unknown>()
    engine(on, { limits: [] }, store)
    await turn($, 't1', 2_000, usage(10, 0, 0))
    expect(store.get(`session:${SESSION}`)).toMatchObject({ sessionId: SESSION, turns: 1, workMs: 2_000 })
  })

  test('a stored session is picked up at session.start', async ($, on) => {
    engine(on, { limits: [] }, new Map([[`session:${SESSION}`, {
        sessionId: SESSION,
        turns: 3,
        workMs: 3_600_000 + 5 * 60_000,
        lastTurnMs: 7_000,
        main: { input: 999_960, cacheWrite: 0, cacheRead: 0, output: 0 },
        agents: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
        quotaSpent: {},
      }]]))
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await turn($, 't4', 60_000)
    const text = await shown(await band($, 'terminal'))
    expect(text).toBe('⏱ 1ч06м (ход 1м00с) · вх 1M · вых 0 · кэш 0')
  })

  test('/clear starts the band over', async ($, on) => {
    engine(on, { limits: [] })
    await turn($, 't1', 2_000)
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
    const ui = await band($, 'terminal')
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
  })
})

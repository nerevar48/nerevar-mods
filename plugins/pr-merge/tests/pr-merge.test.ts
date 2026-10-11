import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const

type World = {
  mergeable: string
  isDirty: boolean
  mergeExit: number
  calls: string[]
  prompts: string[]
  toasts: string[]
}

function world(overrides: Partial<World> = {}): World {
  return { mergeable: 'MERGEABLE', isDirty: false, mergeExit: 0, calls: [], prompts: [], toasts: [], ...overrides }
}

// The host beneath the plugin: gh and git answered from the world, every command logged.
function engine(on: On, w: World) {
  on('process.run', ($, e) => {
    const command = e.argv.join(' ')
    w.calls.push(command)
    if (command.startsWith('gh pr view')) {
      const view = {
        number: 40,
        title: 'Крафт',
        state: 'OPEN',
        isDraft: false,
        mergeable: w.mergeable,
        headRefOid: 'abc123',
        headRefName: 'fix/craft',
        baseRefName: 'main',
        statusCheckRollup: [],
      }
      return { value: { exitCode: 0, stdout: JSON.stringify(view), stderr: '' } }
    }
    if (command.startsWith('git status')) {
      return { value: { exitCode: 0, stdout: w.isDirty ? ' M Assets/a.cs\n' : '', stderr: '' } }
    }
    if (command.startsWith('gh pr merge')) {
      return { value: { exitCode: w.mergeExit, stdout: '', stderr: w.mergeExit === 0 ? '' : 'not mergeable\n' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('prompt.submit', ($, e) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as RenderElement
  })
}

function band($: Engine, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({
    plugin: 'pr-merge',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
}

async function confirmMerge($: Engine, surface: (typeof SURFACES)[number]) {
  await $.session.start({ cwd: '.' })
  const ui = await band($, surface)
  await ui.press({ key: 'merge' })
  await ui.press({ key: 'confirm' })
}

const finishTurn = ($: Engine, isAborted = false) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted, turnId: 't1', reason: 'answer' })

const SYNC = ['git switch main', 'git fetch', 'git pull --ff-only']
const MERGE = 'gh pr merge 40 --squash --match-head-commit abc123'

const after = (calls: string[], command: string) => calls.slice(calls.indexOf(command) + 1)
const gitSteps = (calls: string[]) => calls.filter(c => SYNC.includes(c))

describe('pr-merge', () => {
  for (const surface of SURFACES) {
    test(`${surface}: the band is a divider line, then the colored PR line and its buttons`, async ($, on) => {
      engine(on, world({ mergeable: 'CONFLICTING' }))
      await $.session.start({ cwd: '.' })
      const ui = await band($, surface)
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts[0]?.text).toBe('─'.repeat(200))
      expect(texts[1]?.text).toBe('PR #40 Крафт → main · нет проверок · конфликт')
      expect(texts.find(t => t.text === 'PR #40')?.props).toMatchObject({ color: 'magentaBright', bold: true })
      expect(texts.find(t => t.text === 'конфликт')?.props).toMatchObject({ color: 'red' })
      const labels = (await ui.findAll({ type: 'Button' })).map(b => b.props.label)
      expect(labels).toEqual(['Merge PR #40 (squash)', 'Обновить'])
    })

    test(`${surface}: a clean PR merges, then main is switched to, fetched and pulled`, async ($, on) => {
      const w = world()
      engine(on, w)
      await confirmMerge($, surface)
      expect(w.calls).toContain(MERGE)
      expect(gitSteps(after(w.calls, MERGE))).toEqual(SYNC)
      expect(w.prompts).toEqual([])
      expect(w.toasts).toEqual(['PR #40 смержен, main обновлён'])
    })
  }

  test('uncommitted changes stop the merge before anything runs', async ($, on) => {
    const w = world({ isDirty: true })
    engine(on, w)
    await confirmMerge($, 'terminal')
    expect(w.calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
    expect(gitSteps(w.calls)).toEqual([])
    expect(w.toasts).toEqual(['Есть незакоммиченные изменения: закоммить или убери их перед merge'])
  })

  test('a conflicting PR goes to Claude, and the merge follows its turn', async ($, on) => {
    const w = world({ mergeable: 'CONFLICTING' })
    engine(on, w)
    await confirmMerge($, 'terminal')
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('влей origin/main в fix/craft')
    expect(w.calls.some(c => c.startsWith('gh pr merge'))).toBe(false)

    w.mergeable = 'MERGEABLE'
    await finishTurn($)
    expect(gitSteps(after(w.calls, MERGE))).toEqual(SYNC)
  })

  test('conflicts left after Claude\'s turn cancel the merge', async ($, on) => {
    const w = world({ mergeable: 'CONFLICTING' })
    engine(on, w)
    await confirmMerge($, 'terminal')
    await finishTurn($)
    expect(w.calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
    expect(w.toasts).toEqual(['Конфликты не разрешены до конца, merge отменён'])
  })

  test('an aborted resolving turn cancels the merge', async ($, on) => {
    const w = world({ mergeable: 'CONFLICTING' })
    engine(on, w)
    await confirmMerge($, 'terminal')
    w.mergeable = 'MERGEABLE'
    await finishTurn($, true)
    expect(w.calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })

  test('a refused merge leaves the checkout where it is', async ($, on) => {
    const w = world({ mergeExit: 1 })
    engine(on, w)
    await confirmMerge($, 'terminal')
    expect(gitSteps(w.calls)).toEqual([])
    expect(w.toasts).toEqual(['Merge не удался: not mergeable'])
  })

  test('without a resolving turn, a finished turn does not merge', async ($, on) => {
    const w = world()
    engine(on, w)
    await $.session.start({ cwd: '.' })
    await finishTurn($)
    expect(w.calls.some(c => c.startsWith('gh pr merge'))).toBe(false)
  })
})

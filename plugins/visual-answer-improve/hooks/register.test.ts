import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const message = (text: string) => ({
  plugin: 'visual-answer-improve',
  component: 'AssistantMessage',
  props: { text, isFirstOfReply: true },
} as const)

type Found = { props: Record<string, unknown> }
type Mounted = {
  find: (q: { type?: string; text?: RegExp }) => Promise<Found | undefined>
  findAll: (q: { type?: string }) => Promise<Found[]>
}

// The tab's fill: an SVG path's fill where the tab is an Svg (found by its alt,
// as it shows no text), else the text tab's background.
const tabFill = async (ui: Mounted, label: string): Promise<unknown> => {
  const text = new RegExp(`^${label}$`)
  const svg = (await ui.findAll({ type: 'Svg' })).find(el => text.test(String(el.props.alt)))
  if (svg) return /<path [^>]*fill="([^"]+)"/.exec(String(svg.props.source))?.[1]
  return (await ui.find({ type: 'Text', text }))?.props.backgroundColor
}

const REPLY = [
  'Мод готов.',
  '',
  '### Сделано',
  '- рамки',
  '',
  '### Не сделано',
  '- скриншот',
  '',
  '```md',
  '### Требуется решение',
  '```js',
  '```',
  '',
  '### Требуется решение',
  '1. Цвет?',
].join('\n')

test('marked sections get a tab and a frame of their color', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...message(REPLY), surface })
    for (const [label, color] of [['Сделано', '#3FB950'], ['Не сделано', '#E06C75'], ['Требуется решение', '#F5A623']] as const) {
      expect(await tabFill(ui, label)).toBe(color)
    }
    expect((await ui.findAll({ type: 'Svg' })).length).toBe(surface === 'terminal' ? 0 : 3)
    expect(await ui.find({ type: 'Markdown', text: /^Мод готов\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /^1\. Цвет\?$/ })).toBeDefined()
    // The fenced heading stays inside the "Не сделано" section's text.
    expect(await ui.find({ type: 'Markdown', text: /скриншот[\s\S]*```md\n### Требуется решение\n```js\n```/ })).toBeDefined()
    await ui.unmount()
  }
})

test('replies without marked sections, or with an empty one, are drawn by the engine', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  for (const text of ['## План\n- шаг', '## Summary\n- итог', 'просто текст', '### Сделано\n'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...message(text), surface })
      expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
      await ui.unmount()
    }
})

test('an English heading and a custom color', { options: { doneColor: 'green' } }, async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ ...message('**Done:**\n- frames\n\n## Next\nmore'), surface: 'desktop' })
  // A named color is not put into the SVG: the text tab carries it.
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await tabFill(ui, 'Done')).toBe('green')
  expect(await ui.find({ type: 'Markdown', text: /^## Next\nmore$/ })).toBeDefined()
})

test('CRLF line endings keep fences and a cleared color keeps the label readable', { options: { decisionColor: '' } }, async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  const text = '### Сделано\r\n```md\r\n### Требуется решение\r\n```\r\n\r\n### Требуется решение\r\n1. Да?'
  const ui = await $.ui.mount({ ...message(text), surface: 'terminal' })
  expect(await ui.find({ type: 'Markdown', text: /^```md\r\n### Требуется решение\r\n```$/ })).toBeDefined()
  const tab = await ui.find({ type: 'Text', text: /^Требуется решение$/ })
  expect(tab).toBeDefined()
  expect(tab?.props.color).toBeUndefined()
  expect(tab?.props.backgroundColor).toBeUndefined()
})

test("prompts in the person's words carry the rule, reports do not", async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  const typed = await $.prompt.submit({ text: 'Сделай мод', wait: false, origin: { kind: 'composer' } })
  expect(typed.context?.some(c => c.includes('### Требуется решение'))).toBe(true)
  const report = await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } })
  expect(report.context?.some(c => c.includes('### Требуется решение')) ?? false).toBe(false)
})

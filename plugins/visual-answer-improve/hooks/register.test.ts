import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const message = (text: string) => ({
  plugin: 'visual-answer-improve',
  component: 'AssistantMessage',
  props: { text, isFirstOfReply: true },
} as const)

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
  '```',
  '',
  '### Требуется решение',
  '1. Цвет?',
].join('\n')

test('marked sections get a tab and a frame of their color', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...message(REPLY), surface })
    for (const [label, color] of [['Сделано', '#3FB950'], ['Не сделано', '#E06C75'], ['Требуется решение', '#F5A623']]) {
      const tab = await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) })
      expect(tab?.props.backgroundColor).toBe(color)
      expect(tab?.props.color).toBe('#000000')
    }
    expect(await ui.find({ type: 'Markdown', text: /^Мод готов\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /^1\. Цвет\?$/ })).toBeDefined()
    // The fenced heading stays inside the "Не сделано" section's text.
    expect(await ui.find({ type: 'Markdown', text: /скриншот[\s\S]*```md\n### Требуется решение\n```/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a reply without marked sections is drawn by the engine', async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ ...message('## План\n- шаг'), surface: 'terminal' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
})

test('an English heading and a custom color', { options: { doneColor: 'green' } }, async ($, on) => {
  on('ui.render', { component: 'AssistantMessage' }, () => ({ type: 'engine', ref: 0 }))
  const ui = await $.ui.mount({ ...message('**Done:**\n- frames\n\n## Next\nmore'), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^Done$/ }))?.props.backgroundColor).toBe('green')
  expect(await ui.find({ type: 'Markdown', text: /^## Next\nmore$/ })).toBeDefined()
})

test("prompts in the person's words carry the rule, reports do not", async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  const typed = await $.prompt.submit({ text: 'Сделай мод', wait: false, origin: { kind: 'composer' } })
  expect(typed.context?.some(c => c.includes('### Требуется решение'))).toBe(true)
  const report = await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } })
  expect(report.context?.some(c => c.includes('### Требуется решение')) ?? false).toBe(false)
})

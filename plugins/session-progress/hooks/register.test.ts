import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'session-progress',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const SURFACES = ['terminal', 'desktop'] as const

type Mounted = {
  find: (q: { type?: string; text?: RegExp }) => Promise<{ props: Record<string, unknown> } | undefined>
}

// Whether the band shows `re`: the desktop row's alt, or any Text on the terminal.
const has = async (ui: Mounted, surface: (typeof SURFACES)[number], re: RegExp): Promise<boolean> => {
  if (surface === 'desktop') return re.test(String((await ui.find({ type: 'Svg' }))?.props.alt ?? ''))
  return (await ui.find({ type: 'Text', text: re })) !== undefined
}

const expectShown = async (ui: Mounted, surface: (typeof SURFACES)[number], ...all: RegExp[]) => {
  for (const re of all) expect(await has(ui, surface, re)).toBe(true)
}

test('no plan, no band', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'session-progress-dismiss' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the progress tool draws steps, advances current and finishes', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  await $.tool.call({ tool: 'mcp__session-progress__progress', title: 'Fix login', steps: ['Read code', 'Patch', 'Test', 'Commit'] })
  await $.tool.call({ tool: 'mcp__session-progress__progress', done: 2 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await expectShown(ui, surface, /Fix login/, /Test/, /2\/4/, /50%/)
    await ui.unmount()
  }
  await $.tool.call({ tool: 'mcp__session-progress__progress', finished: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await expectShown(ui, 'terminal', /100%/)
  await ui.press({ key: 'session-progress-dismiss' })
  expect(await ui.find({ key: 'session-progress-dismiss' })).toBeUndefined()
})

test('a todo list moves the bar and keeps the reported title', async ($, on) => {
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  await $.tool.call({ tool: 'mcp__session-progress__progress', title: 'Refactor' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Split module', status: 'completed', activeForm: 'Splitting module' },
      { content: 'Update imports', status: 'in_progress', activeForm: 'Updating imports' },
      { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
    ],
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await expectShown(ui, 'terminal', /Refactor/, /Updating imports/, /1\/3/, /33%/)
})

test('tasks from TaskCreate and TaskUpdate count toward the bar', async ($, on) => {
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, ($, e) => ({ result: { task: { id: String(++n), subject: String(e.subject) } } }))
  on('tool.call', { tool: 'TaskUpdate' }, ($, e) => ({ result: { success: true, taskId: String(e.taskId), updatedFields: ['status'] } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'One', description: 'first' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Two', description: 'second' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Doing two' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await expectShown(ui, 'terminal', /Doing two/, /1\/2/, /50%/)
})

test("prompts in the person's words carry the rule", async ($, on) => {
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }))
  const entered = await $.prompt.submit({ text: 'Fix the login flow', asUser: true })
  expect(entered.context?.some(c => c.includes('mcp__session-progress__progress'))).toBe(true)
})

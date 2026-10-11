import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const CWD = 'D:\\Proj\\demo'
const TEMP = 'C:\\Temp'
const SESSION = 'aaaaaaaa-1111'
const OTHER = 'bbbbbbbb-2222'
const SESSIONS_DIR = 'C:\\Temp\\claude\\D--Proj-demo'

const IMAGES = [
  { path: `${SESSIONS_DIR}\\${SESSION}\\scratchpad\\concept.png`, name: 'concept.png', source: 'session', session: SESSION, size: 50_000, mtimeMs: 3000 },
  { path: `${CWD}\\docs\\logo.svg`, name: 'logo.svg', source: 'project', session: null, size: 400, mtimeMs: 2000 },
  { path: `${SESSIONS_DIR}\\${OTHER}\\scratchpad\\huge.webp`, name: 'huge.webp', source: 'session', session: OTHER, size: 900_000, mtimeMs: 1000 },
]

type World = { scans: unknown[]; thumbRequests: string[][]; opened: string[]; panes: string[] }

function engine(on: On): World {
  const w: World = { scans: [], thumbRequests: [], opened: [], panes: [] }
  mock.env(on, { TEMP, USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Local' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: SESSION }))
  on('command.register', () => ({ value: undefined }))
  on('fs.list', () => ({
    value: [SESSION, OTHER].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', ($, e) => ({ value: { base64: e.path.endsWith('.jpg') ? 'VEhVTUI=' : 'U1ZH' } }))
  on('process.run', ($, e) => {
    const mode = e.argv[e.argv.indexOf('-Mode') + 1]
    const input = JSON.parse(e.init?.stdin ?? 'null')
    if (mode === 'scan') {
      w.scans.push(input)
      return { value: { exitCode: 0, stdout: '\uFEFF' + JSON.stringify(IMAGES), stderr: '' } }
    }
    if (mode === 'thumbs') {
      w.thumbRequests.push(input)
      const made = Object.fromEntries(input.map((path: string) => [path, 'C:\\Local\\thumb.jpg']))
      return { value: { exitCode: 0, stdout: JSON.stringify(made), stderr: '' } }
    }
    w.opened.push(e.argv.join(' '))
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('ui.open', ($, e) => {
    w.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: w.panes.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'модель') as RenderElement
  })
  return w
}

function pane($: Engine, surface: 'terminal' | 'desktop') {
  return $.ui.mount({
    plugin: 'image-library',
    surface,
    component: 'Pane',
    requestId: 'image-library',
    props: { title: 'Библиотека', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
}

async function openLibrary($: Engine) {
  await $.session.start({ cwd: CWD })
  await $.command.run({ command: 'library', args: '' })
}

describe('image-library', () => {
  test('/library opens the pane and scans the project, every session of it and Codex', async ($, on) => {
    const w = engine(on)
    await openLibrary($)
    expect(w.panes).toEqual(['image-library'])
    expect(w.scans).toEqual([
      [
        { source: 'project', session: null, path: CWD },
        { source: 'session', session: SESSION, path: `${SESSIONS_DIR}\\${SESSION}` },
        { source: 'session', session: OTHER, path: `${SESSIONS_DIR}\\${OTHER}` },
        { source: 'codex', session: null, path: 'C:\\Users\\me\\.codex\\generated_images' },
      ],
    ])
    // Миниатюры только для форматов, которые читает System.Drawing.
    expect(w.thumbRequests).toEqual([[IMAGES[0]!.path]])
  })

  test('desktop: a tile per image, newest first; thumbnail, small svg inline, big webp as a placeholder', async ($, on) => {
    engine(on)
    await openLibrary($)
    const ui = await pane($, 'desktop')
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.map(svg => svg.props.alt)).toEqual(['concept.png', 'logo.svg'])
    expect(String(svgs[0]!.props.source)).toContain('data:image/jpeg;base64,VEhVTUI=')
    expect(String(svgs[1]!.props.source)).toContain('data:image/svg+xml;base64,U1ZH')
    expect((await ui.find({ type: 'Text', text: 'WEBP' }))).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /эта сессия/ })).toBeDefined()
  })

  test('the filter narrows to one session, and a press opens the file', async ($, on) => {
    const w = engine(on)
    await openLibrary($)
    const ui = await pane($, 'desktop')
    await ui.select({ key: 'filter', value: `session:${OTHER}` })
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key))
    expect(buttons.filter(key => key.startsWith('open:'))).toEqual([`open:${IMAGES[2]!.path}`])
    await ui.press({ key: `open:${IMAGES[2]!.path}` })
    expect(w.opened).toEqual([`explorer.exe ${IMAGES[2]!.path}`])
  })

  test('sorting flips to oldest first', async ($, on) => {
    engine(on)
    await openLibrary($)
    const ui = await pane($, 'desktop')
    await ui.press({ key: 'sort' })
    const keys = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(key => key.startsWith('open:'))
    expect(keys).toEqual(IMAGES.map(image => `open:${image.path}`).reverse())
  })

  test('terminal: a row per image, no Svg', async ($, on) => {
    engine(on)
    await openLibrary($)
    const ui = await pane($, 'terminal')
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('open:'))).toHaveLength(3)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: the footer gets a Библиотека button before what other plugins draw`, async ($, on) => {
      const w = engine(on)
      await $.session.start({ cwd: CWD })
      const ui = await $.ui.mount({ plugin: 'image-library', surface, component: 'SessionMode', props: { modes: [] } })
      expect((await ui.find({ type: 'Text', text: 'модель' }))).toBeDefined()
      await ui.press({ key: 'image-library-open' })
      expect(w.panes).toEqual(['image-library'])
    })
  }
})

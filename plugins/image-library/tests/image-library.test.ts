import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const CWD = 'D:\\Proj\\demo'
const TEMP = 'C:\\Temp'
const SESSION = 'aaaaaaaa-1111'
const OTHER = 'bbbbbbbb-2222'
const SESSIONS_DIR = 'C:\\Temp\\claude\\D--Proj-demo'
const SVG_SOURCE_LIMIT = 131_072

type Image = { path: string; name: string; source: string; session: string | null; size: number; mtimeMs: number }

const IMAGES: Image[] = [
  { path: `${SESSIONS_DIR}\\${SESSION}\\scratchpad\\concept.png`, name: 'concept.png', source: 'session', session: SESSION, size: 50_000, mtimeMs: 3000 },
  { path: `${CWD}\\docs\\logo.svg`, name: 'logo.svg', source: 'project', session: null, size: 400, mtimeMs: 2000 },
  { path: `${SESSIONS_DIR}\\${OTHER}\\scratchpad\\huge.webp`, name: 'huge.webp', source: 'session', session: OTHER, size: 900_000, mtimeMs: 1000 },
]

type World = {
  images: Image[]
  scanError: string
  thumbsError: string
  isPaneShown: boolean
  missingFiles: string[]
  settle: () => Promise<void>
  scans: unknown[]
  thumbRequests: string[][]
  opened: string[]
  panes: string[]
  toasts: string[]
}

function engine(on: On, overrides: Partial<World> = {}): World {
  const w: World = {
    images: IMAGES,
    scanError: '',
    thumbsError: '',
    isPaneShown: true,
    missingFiles: [],
    settle: async () => {},
    scans: [],
    thumbRequests: [],
    opened: [],
    panes: [],
    toasts: [],
    ...overrides,
  }
  w.settle = mock.clock(on).settle
  mock.env(on, { TEMP, USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: 'C:\\Local' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer, usage: e.usage }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: SESSION }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: [SESSION, OTHER].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('fs.exists', ($, e) => ({ value: !w.missingFiles.includes(e.path) }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('.jpg')) return { value: { base64: 'VEhVTUI=' } }
    const image = w.images.find(one => one.path === e.path)
    // base64 исходника: 4 символа на 3 байта.
    return { value: { base64: 'A'.repeat(Math.ceil((image?.size ?? 3) / 3) * 4) } }
  })
  on('process.run', ($, e) => {
    const mode = e.argv[e.argv.indexOf('-Mode') + 1]
    const input = JSON.parse(e.init?.stdin ?? 'null')
    const ran = (exitCode: number, stdout: string, stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (mode === 'scan') {
      w.scans.push(input)
      return w.scanError ? ran(1, '', w.scanError) : ran(0, '\uFEFF' + JSON.stringify(w.images))
    }
    if (mode === 'thumbs') {
      w.thumbRequests.push(input)
      if (w.thumbsError) return ran(1, '', w.thumbsError)
      return ran(0, JSON.stringify(Object.fromEntries(input.map((path: string) => [path, 'C:\\Local\\thumb.jpg']))))
    }
    w.opened.push(e.argv.join(' '))
    return ran(1, '')
  })
  on('ui.open', ($, e) => {
    w.panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: w.panes.map(id => ({ id, title: id, isShown: w.isPaneShown, isFocused: false, isPlaced: true })),
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

// Ход завершается, пересканирование идёт без ожидания: дать ему дойти до конца.
async function finishTurn($: Engine, w: World) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.settle()
}

async function openKeys(ui: Awaited<ReturnType<typeof pane>>) {
  return (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(key => key.startsWith('open:'))
}

describe('image-library', () => {
  test('/library opens the pane and scans the project (build dirs skipped), every session of it and Codex', async ($, on) => {
    const w = engine(on)
    await openLibrary($)
    expect(w.panes).toEqual(['image-library'])
    expect(w.scans).toEqual([
      [
        { source: 'project', session: null, path: CWD, skipBuildDirs: true },
        { source: 'session', session: SESSION, path: `${SESSIONS_DIR}\\${SESSION}`, skipBuildDirs: false },
        { source: 'session', session: OTHER, path: `${SESSIONS_DIR}\\${OTHER}`, skipBuildDirs: false },
        { source: 'codex', session: null, path: 'C:\\Users\\me\\.codex\\generated_images', skipBuildDirs: false },
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
    expect(String(svgs[1]!.props.source)).toContain('data:image/svg+xml;base64,')
    expect(await ui.find({ type: 'Text', text: 'WEBP' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /эта сессия/ })).toBeDefined()
    expect(await openKeys(ui)).toEqual(IMAGES.map(image => `open:${image.path}`))
  })

  test('desktop: a source at the embed limit still fits the Svg source limit', async ($, on) => {
    const webp = { ...IMAGES[2]!, size: 90_000 }
    engine(on, { images: [webp] })
    await openLibrary($)
    const svgs = await (await pane($, 'desktop')).findAll({ type: 'Svg' })
    expect(svgs).toHaveLength(1)
    expect(String(svgs[0]!.props.source).length).toBeLessThan(SVG_SOURCE_LIMIT)
  })

  test('a file rewritten since the last scan gets a new thumbnail', async ($, on) => {
    const w = engine(on)
    await openLibrary($)
    w.images = [{ ...IMAGES[0]!, mtimeMs: 4000 }, ...IMAGES.slice(1)]
    await finishTurn($, w)
    expect(w.thumbRequests).toEqual([[IMAGES[0]!.path], [IMAGES[0]!.path]])
  })

  test('a thumbnail whose cached file vanished is made again', async ($, on) => {
    const w = engine(on)
    await openLibrary($)
    w.missingFiles = ['C:\\Local\\thumb.jpg']
    await (await pane($, 'desktop')).press({ key: 'sort' })
    expect(w.thumbRequests).toEqual([[IMAGES[0]!.path], [IMAGES[0]!.path]])
  })

  test('a finished turn rescans only while the pane is on screen', async ($, on) => {
    const w = engine(on, { isPaneShown: false })
    await openLibrary($)
    await finishTurn($, w)
    expect(w.scans).toHaveLength(1)
    w.isPaneShown = true
    await finishTurn($, w)
    expect(w.scans).toHaveLength(2)
  })

  test('a failed scan shows its error; a failed thumbnail run does not mark the scan failed', async ($, on) => {
    const w = engine(on, { scanError: 'доступ запрещён' })
    await openLibrary($)
    const failed = await pane($, 'desktop')
    expect(await failed.find({ type: 'Text', text: /доступ запрещён/ })).toBeDefined()
    await failed.unmount()

    w.scanError = ''
    w.thumbsError = 'GDI+'
    await finishTurn($, w)
    const ui = await pane($, 'desktop')
    expect(await ui.find({ type: 'Text', text: /Ошибка сканирования/ })).toBeUndefined()
    expect(await openKeys(ui)).toHaveLength(3)
    expect(w.toasts.some(text => text.includes('GDI+'))).toBe(true)
  })

  test('the filter narrows to one session, and a press opens the file', async ($, on) => {
    const w = engine(on)
    await openLibrary($)
    const ui = await pane($, 'desktop')
    await ui.select({ key: 'filter', value: `session:${OTHER}` })
    expect(await openKeys(ui)).toEqual([`open:${IMAGES[2]!.path}`])
    await ui.press({ key: `open:${IMAGES[2]!.path}` })
    expect(w.opened).toEqual([`explorer.exe ${IMAGES[2]!.path}`])
  })

  test('a file deleted after the scan is not opened, a toast says so', async ($, on) => {
    const w = engine(on, { missingFiles: [IMAGES[1]!.path] })
    await openLibrary($)
    await (await pane($, 'desktop')).press({ key: `open:${IMAGES[1]!.path}` })
    expect(w.opened).toEqual([])
    expect(w.toasts).toEqual([`Файла уже нет: ${IMAGES[1]!.path}`])
  })

  test('pages of 24: the pager moves between them, thumbnails follow, the filter goes back to page 1', async ($, on) => {
    const many: Image[] = Array.from({ length: 60 }, (_, index) => ({
      path: `${CWD}\\shots\\${String(index).padStart(2, '0')}.png`,
      name: `${index}.png`,
      source: 'project',
      session: null,
      size: 10_000,
      mtimeMs: 10_000 - index,
    }))
    const w = engine(on, { images: many })
    await openLibrary($)
    const ui = await pane($, 'desktop')
    const pathsOf = (keys: string[]) => keys.map(key => key.slice('open:'.length))
    expect(pathsOf(await openKeys(ui))).toEqual(many.slice(0, 24).map(image => image.path))
    expect(await ui.find({ type: 'Text', text: /стр\. 1 из 3/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('top:page:')).map(b => b.props.label)).toEqual(['1', '2', '3'])

    await ui.press({ key: 'bottom:page:2' })
    expect(pathsOf(await openKeys(ui))).toEqual(many.slice(24, 48).map(image => image.path))
    expect(w.thumbRequests.at(-1)).toEqual(many.slice(24, 48).map(image => image.path))

    await ui.press({ key: 'top:next' })
    expect(pathsOf(await openKeys(ui))).toEqual(many.slice(48).map(image => image.path))
    await ui.press({ key: 'top:next' })
    expect(await ui.find({ type: 'Text', text: /стр\. 3 из 3/ })).toBeDefined()

    await ui.press({ key: 'top:prev' })
    expect(await ui.find({ type: 'Text', text: /стр\. 2 из 3/ })).toBeDefined()
    await ui.select({ key: 'filter', value: 'project' })
    expect(await ui.find({ type: 'Text', text: /стр\. 1 из 3/ })).toBeDefined()
  })

  test('two quick › presses move two pages; a gap of one page shows that page', async ($, on) => {
    const many: Image[] = Array.from({ length: 240 }, (_, index) => ({
      path: `${CWD}\shots\${index}.png`,
      name: `${index}.png`,
      source: 'project',
      session: null,
      size: 10_000,
      mtimeMs: 100_000 - index,
    }))
    engine(on, { images: many })
    await openLibrary($)
    const ui = await pane($, 'desktop')
    await Promise.all([ui.press({ key: 'top:next' }), ui.press({ key: 'top:next' })])
    await ui.press({ key: 'top:next' })
    await ui.press({ key: 'top:next' })
    expect(await ui.find({ type: 'Text', text: /стр\. 5 из 10/ })).toBeDefined()
    const labels = (await ui.findAll({ type: 'Button' }))
      .filter(b => /^top:(page|gap)/.test(String(b.props.key)))
      .map(b => b.props.label)
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '10'])
  })

  test('sorting flips to oldest first', async ($, on) => {
    engine(on)
    await openLibrary($)
    const ui = await pane($, 'desktop')
    await ui.press({ key: 'sort' })
    expect(await openKeys(ui)).toEqual(IMAGES.map(image => `open:${image.path}`).reverse())
  })

  test('terminal: a row per image, no Svg', async ($, on) => {
    engine(on)
    await openLibrary($)
    const ui = await pane($, 'terminal')
    expect(await ui.findAll({ type: 'Svg' })).toEqual([])
    expect(await openKeys(ui)).toHaveLength(3)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: the footer gets a Библиотека button beside what the hooks beneath draw`, async ($, on) => {
      const w = engine(on)
      await $.session.start({ cwd: CWD })
      const ui = await $.ui.mount({ plugin: 'image-library', surface, component: 'SessionMode', props: { modes: [] } })
      expect(await ui.find({ type: 'Text', text: 'модель' })).toBeDefined()
      await ui.press({ key: 'image-library-open' })
      expect(w.panes).toEqual(['image-library'])
    })
  }
})

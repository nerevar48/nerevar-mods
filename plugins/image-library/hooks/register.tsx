import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Filter, LibraryImage, Source } from '../types'

const PANE = 'image-library'
const TITLE = 'Библиотека'
const COMMAND = 'library'
const PAGE = 24
const THUMB_PX = 192
// Исходник не больше этого (байт) вкладывается в Svg как есть, когда миниатюры нет:
// его base64 (×4/3) с обёрткой укладывается в 131072 символа source у Svg.
const EMBED_LIMIT = 90_000
const SCRIPT_TIMEOUT_MS = 120_000
// Миниатюры делает System.Drawing: он читает эти форматы, а webp и svg нет.
const THUMBABLE = ['png', 'jpg', 'jpeg', 'gif']
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}
const SOURCE_LABEL: Record<Source, string> = { project: 'проект', session: 'сессия', codex: 'Codex' }

const images = atom({ plugin: 'image-library', key: 'images' } as const, [])
const status = atom({ plugin: 'image-library', key: 'status' } as const, 'idle')
const error = atom({ plugin: 'image-library', key: 'error' } as const, '')
const filter = atom({ plugin: 'image-library', key: 'filter' } as const, 'all')
const isOldestFirst = atom({ plugin: 'image-library', key: 'isOldestFirst' } as const, false)
const limit = atom({ plugin: 'image-library', key: 'limit' } as const, PAGE)
const thumbs = atom({ plugin: 'image-library', key: 'thumbs' } as const, {})

type Root = { source: Source; session: string | null; path: string; skipBuildDirs: boolean }
type Settings = { includeCodex: boolean; scanLimit: number }

function extensionOf(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1).toLowerCase()
}

function join(...parts: string[]): string {
  return parts.map((part, i) => (i === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, ''))).join('\\')
}

// Папка сессий проекта в temp: путь проекта, где всё, кроме букв и цифр, заменено на «-».
function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

function parseJson<T>(text: string, fallback: T): T {
  const body = text.replace(/^﻿/, '').trim()
  return body ? (JSON.parse(body) as T) : fallback
}

async function runScript($: EngineInterface, args: string[], input: unknown): Promise<string> {
  const script = join($.plugin.root, 'scripts', 'library.ps1')
  const argv = ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]
  const ran = await $.process.run(argv, { stdin: JSON.stringify(input), timeoutMs: SCRIPT_TIMEOUT_MS })

  if (ran.exitCode !== 0) {
    throw new Error(ran.stderr.trim().slice(0, 400) || `library.ps1: код ${ran.exitCode}`)
  }

  return ran.stdout
}

async function rootsOf($: EngineInterface, settings: Settings): Promise<Root[]> {
  const cwd = await $.session.cwd()
  const roots: Root[] = [{ source: 'project', session: null, path: cwd, skipBuildDirs: true }]
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))

  if (temp) {
    const sessionsDir = join(temp, 'claude', projectSlug(cwd))
    const entries = await $.fs.list(sessionsDir).catch(() => [])

    for (const entry of entries) {
      if (entry.kind === 'dir') {
        roots.push({ source: 'session', session: entry.name, path: join(sessionsDir, entry.name), skipBuildDirs: false })
      }
    }
  }

  const home = await $.env.get('USERPROFILE')

  if (settings.includeCodex && home) {
    roots.push({ source: 'codex', session: null, path: join(home, '.codex', 'generated_images'), skipBuildDirs: false })
  }

  return roots
}

function matches(image: LibraryImage, current: Filter): boolean {
  if (current === 'all') return true
  if (current === 'sessions') return image.source === 'session'
  if (current.startsWith('session:')) return image.session === current.slice('session:'.length)
  return image.source === current
}

// Ключ миниатюры с mtime: перезаписанный файл получает новую.
function thumbKey(image: LibraryImage): string {
  return `${image.path}|${image.mtimeMs}`
}

function sortedFiltered(list: readonly LibraryImage[], current: Filter, oldestFirst: boolean): LibraryImage[] {
  const chosen = list.filter(image => matches(image, current))
  return oldestFirst ? chosen.reverse() : chosen
}

// Миниатюры видимой страницы: одна команда на все недостающие. Запрос во время
// работы ставит флаг, и цикл проходит ещё раз; проверка флага и сброс идут без await между ними.
let thumbsRun: Promise<void> | undefined
let isThumbsAgain = false

function ensureThumbs($: EngineInterface, cacheDir: string): Promise<void> {
  isThumbsAgain = true
  if (thumbsRun) return thumbsRun

  thumbsRun = (async () => {
    try {
      while (isThumbsAgain) {
        isThumbsAgain = false
        const known = await read($, thumbs)
        const shown = sortedFiltered(await read($, images), await read($, filter), await read($, isOldestFirst))
        const missing = shown
          .slice(0, await read($, limit))
          .filter(image => !(thumbKey(image) in known) && THUMBABLE.includes(extensionOf(image.path)))

        if (missing.length > 0) {
          const args = ['-Mode', 'thumbs', '-CacheDir', cacheDir, '-Size', String(THUMB_PX)]
          const made = parseJson<Record<string, string | null>>(await runScript($, args, missing.map(image => image.path)), {})
          const byKey = Object.fromEntries(missing.map(image => [thumbKey(image), made[image.path] ?? null]))
          await update($, thumbs, current => ({ ...current, ...byKey }))
        }
      }
    } finally {
      thumbsRun = undefined
    }
  })()

  return thumbsRun
}

// Номер последнего запущенного скана: результат более старого отбрасывается.
let scanGeneration = 0

async function scan($: EngineInterface, settings: Settings, cacheDir: string): Promise<void> {
  const generation = ++scanGeneration
  await update($, status, () => 'scanning')

  try {
    const roots = await rootsOf($, settings)
    const found = parseJson<LibraryImage[]>(
      await runScript($, ['-Mode', 'scan', '-Limit', String(settings.scanLimit)], roots),
      [],
    )
    if (generation !== scanGeneration) return
    const present = new Set(found.map(thumbKey))
    await update($, images, () => found)
    await update($, thumbs, current => Object.fromEntries(Object.entries(current).filter(([key]) => present.has(key))))
    await update($, error, () => '')
    await update($, status, () => 'idle')
  } catch (failure) {
    if (generation !== scanGeneration) return
    await update($, error, () => (failure instanceof Error ? failure.message : String(failure)))
    await update($, status, () => 'error')
    return
  }

  await ensureThumbs($, cacheDir).catch(failure => $.ui.toast(`Миниатюры: ${String(failure)}`))
}

async function openFile($: EngineInterface, path: string): Promise<void> {
  if (!(await $.fs.exists(path))) {
    $.ui.toast(`Файла уже нет: ${path}`)
    return
  }
  // explorer.exe открывает файл приложением по умолчанию; код выхода у него всегда 1.
  await $.process.run(['explorer.exe', path], { timeoutMs: 10_000 }).catch(() => $.ui.toast(`Не удалось открыть ${path}`))
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dateText(mtimeMs: number): string {
  const date = new Date(mtimeMs)
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortName(name: string): string {
  return name.length > 24 ? `${name.slice(0, 11)}…${name.slice(-12)}` : name
}

function sourceText(image: LibraryImage, currentSession: string): string {
  if (image.source !== 'session') return SOURCE_LABEL[image.source]
  return image.session === currentSession ? 'эта сессия' : `сессия ${image.session?.slice(0, 8) ?? ''}`
}

function svgOf(mime: string, base64: string, width: number, height: number): string {
  const href = `data:${mime};base64,${base64}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image href="${href}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`
  )
}

// base64 прочитанных файлов (миниатюра ~10 КБ); самые давние вытесняются первыми.
const bytesCache = new Map<string, string>()
const BYTES_CACHE_LIMIT = 600

async function base64Of($: EngineInterface, path: string, cacheKey = path): Promise<string | null> {
  const cached = bytesCache.get(cacheKey)
  if (cached !== undefined) return cached

  const bytes = await $.fs.read(path, { as: 'bytes' }).then(
    read => read.base64,
    () => null,
  )
  if (bytes === null) return null
  const oldest = bytesCache.keys().next()
  if (bytesCache.size >= BYTES_CACHE_LIMIT && !oldest.done) bytesCache.delete(oldest.value)
  bytesCache.set(cacheKey, bytes)
  return bytes
}

// Что показать в плитке: миниатюра, либо сам файл, если он мал, либо ничего.
async function pictureOf(
  $: EngineInterface,
  image: LibraryImage,
  thumbPath: string | null | undefined,
): Promise<{ mime: string; base64: string } | null> {
  if (thumbPath) {
    const base64 = await base64Of($, thumbPath)
    if (base64) return { mime: 'image/jpeg', base64 }
  }

  const mime = MIME[extensionOf(image.path)]
  if (!mime || image.size > EMBED_LIMIT) return null
  const base64 = await base64Of($, image.path, thumbKey(image))
  return base64 ? { mime, base64 } : null
}

function filterOptions(list: readonly LibraryImage[], currentSession: string) {
  const counts = new Map<string, number>()
  for (const image of list) {
    if (image.session) counts.set(image.session, (counts.get(image.session) ?? 0) + 1)
  }
  const count = (source: Source) => list.filter(image => image.source === source).length
  const options = [
    { value: 'all', label: `Все (${list.length})` },
    { value: 'project', label: `Проект (${count('project')})` },
    { value: 'sessions', label: `Все сессии (${count('session')})` },
  ]
  if (count('codex') > 0) options.push({ value: 'codex', label: `Codex (${count('codex')})` })
  for (const [session, n] of counts) {
    const name = session === currentSession ? 'Эта сессия' : `Сессия ${session.slice(0, 8)}`
    options.push({ value: `session:${session}`, label: `${name} (${n})` })
  }
  return options
}

async function openLibrary($: EngineInterface, settings: Settings, cacheDir: string): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
  await scan($, settings, cacheDir)
}

async function isShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)
}

// Смена фильтра, сортировки или страницы, затем миниатюры для новой видимой страницы.
async function changeView($: EngineInterface, cacheDir: string, apply: () => Promise<unknown>): Promise<void> {
  await apply()
  await ensureThumbs($, cacheDir).catch(failure => $.ui.toast(`Миниатюры: ${String(failure)}`))
}

async function setFilter($: EngineInterface, value: Filter): Promise<void> {
  await update($, filter, () => value)
  await update($, limit, () => PAGE)
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    includeCodex: options.includeCodex !== false,
    scanLimit: typeof options.scanLimit === 'number' && options.scanLimit > 0 ? options.scanLimit : 3000,
  }
  let currentSession = ''
  let cacheDir = ''

  on('session.start', async ($, e, next) => {
    currentSession = await $.session.id()
    const local = (await $.env.get('LOCALAPPDATA')) ?? (await $.env.get('TEMP')) ?? '.'
    cacheDir = join(local, 'claude-image-library', 'thumbs')
    await $.command.register({ name: COMMAND, description: 'Библиотека изображений проекта и сессий' })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openLibrary($, settings, cacheDir)
    return { text: 'Библиотека открыта.' }
  })

  // Новые картинки за ход: пересканировать, пока панель на экране.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (await isShown($)) void scan($, settings, cacheDir)
    return result
  })

  // Кнопка в футере поля ввода; то, что рисуют хуки ниже (режимы, другие моды), идёт следом.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Button key="image-library-open" plain label="🖼 Библиотека" onPress={() => openLibrary($, settings, cacheDir)} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const all = await read($, images)
    const current = await read($, filter)
    const oldestFirst = await read($, isOldestFirst)
    const shownLimit = await read($, limit)
    const known = await read($, thumbs)
    const scanStatus = await read($, status)
    const scanError = await read($, error)
    const chosen = sortedFiltered(all, current, oldestFirst)
    const page = chosen.slice(0, shownLimit)

    const header = (
      <Box key="header" flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
        {'Select' in ui && (
          <ui.Select
            key="filter"
            options={filterOptions(all, currentSession)}
            value={current}
            onSelect={(value: string) => changeView($, cacheDir, () => setFilter($, value))}
          />
        )}
        <Button
          key="sort"
          label={oldestFirst ? '↑ Сначала старые' : '↓ Сначала новые'}
          onPress={() => changeView($, cacheDir, () => update($, isOldestFirst, value => !value))}
        />
        <Button key="refresh" label="Обновить" onPress={() => scan($, settings, cacheDir)} />
        <Text dimColor>
          {scanStatus === 'scanning' ? 'Сканирую…' : `${chosen.length} изобр.`}
        </Text>
      </Box>
    )

    const pictures = 'Svg' in ui ? await Promise.all(page.map(image => pictureOf($, image, known[thumbKey(image)]))) : []
    const tiles: RenderElement[] = []

    for (const [index, image] of page.entries()) {
      const caption = `${dateText(image.mtimeMs)} · ${sourceText(image, currentSession)}`
      const open = () => openFile($, image.path)

      // Svg есть на desktop, mobile и vscode; терминал получает список строк.
      if (!('Svg' in ui)) {
        tiles.push(
          <Button key={`open:${image.path}`} plain onPress={open}>
            {shortName(image.name)} <Text dimColor>{caption}</Text>
          </Button>,
        )
        continue
      }

      const { Svg } = ui
      const picture = pictures[index]
      tiles.push(
        <Box key={`tile:${image.path}`} flexDirection="column" width={26}>
          {picture ? (
            <Svg source={svgOf(picture.mime, picture.base64, 176, 132)} alt={image.name} width={176} height={132} />
          ) : (
            <Box height={6} borderStyle="round" justifyContent="center" alignItems="center">
              <Text dimColor>{extensionOf(image.path).toUpperCase()}</Text>
            </Box>
          )}
          <Button key={`open:${image.path}`} plain onPress={open}>
            {shortName(image.name)}
          </Button>
          <Text dimColor>{caption}</Text>
        </Box>,
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {scanStatus === 'error' && <Text color="red">Ошибка сканирования: {scanError}</Text>}
        {chosen.length === 0 && scanStatus !== 'scanning' && <Text dimColor>Изображений не найдено.</Text>}
        <Box key="grid" flexDirection={e.surface === 'terminal' ? 'column' : 'row'} flexWrap="wrap" gap={1}>
          {tiles}
        </Box>
        {chosen.length > page.length && (
          <Button
            key="more"
            label={`Показать ещё (${chosen.length - page.length})`}
            onPress={() => changeView($, cacheDir, () => update($, limit, value => value + PAGE))}
          />
        )}
      </Box>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Filter, LibraryImage, Preview, Source } from '../types'

const PANE = 'image-library'
const TITLE = 'Библиотека'
const COMMAND = 'library'
const PAGE = 24
const THUMB_PX = 192
// Исходник не больше этого (байт) вкладывается в Svg как есть, когда миниатюры нет:
// его base64 (×4/3) с обёрткой укладывается в 131072 символа source у Svg.
const EMBED_LIMIT = 90_000
const SCRIPT_TIMEOUT_MS = 120_000
const PREVIEW_WIDTH = 1600
// Байт на полосу просмотра: её base64 с обёрткой укладывается в source одной Svg.
const STRIP_BYTES = 95_000
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
const page = atom({ plugin: 'image-library', key: 'page' } as const, 0)
const thumbs = atom({ plugin: 'image-library', key: 'thumbs' } as const, {})
const viewing = atom({ plugin: 'image-library', key: 'viewing' } as const, null)
const previews = atom({ plugin: 'image-library', key: 'previews' } as const, {})

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

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE))
}

// Изображения страницы; номер за последней страницей (список сократился) — последняя.
function pageOf(list: readonly LibraryImage[], index: number): { images: LibraryImage[]; index: number } {
  const clamped = Math.min(Math.max(0, index), pageCount(list.length) - 1)
  return { images: list.slice(clamped * PAGE, clamped * PAGE + PAGE), index: clamped }
}

// Номера страниц в переключателе: первая, последняя и соседи текущей; null — пропуск «…».
// Пропуск ровно одной страницы показывает её саму.
function pageNumbers(current: number, total: number): (number | null)[] {
  const isNear = (index: number) => index === 0 || index === total - 1 || Math.abs(index - current) <= 2
  const numbers: (number | null)[] = []
  for (let index = 0; index < total; index++) {
    if (isNear(index) || (isNear(index - 1) && isNear(index + 1))) {
      numbers.push(index)
    } else if (numbers.at(-1) !== null) {
      numbers.push(null)
    }
  }
  return numbers
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
        // Миниатюра, файл которой исчез из кэша на диске, делается заново.
        const visible = pageOf(shown, await read($, page)).images.filter(image => THUMBABLE.includes(extensionOf(image.path)))
        const isMade = await Promise.all(
          visible.map(async image => {
            const thumb = known[thumbKey(image)]
            return thumb === undefined ? false : thumb === null || (await $.fs.exists(thumb).catch(() => false))
          }),
        )
        const missing = visible.filter((_, index) => !isMade[index])

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
    // Открытый в просмотре файл исчез: вернуться к галерее.
    const paths = new Set(found.map(image => image.path))
    await update($, viewing, current => (current !== null && paths.has(current) ? current : null))
    // Список мог сократиться: номер страницы остаётся в его пределах.
    await update($, page, current => Math.min(current, pageCount(found.length) - 1))
    const isPresent = ([key]: [string, unknown]) => present.has(key)
    await update($, thumbs, current => Object.fromEntries(Object.entries(current).filter(isPresent)))
    await update($, previews, current => Object.fromEntries(Object.entries(current).filter(isPresent)))
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

// Путь кладёт в буфер Windows скрипт: $.ui.copy на desktop в системный буфер не пишет.
async function copyPath($: EngineInterface, path: string): Promise<void> {
  const isCopied = await runScript($, ['-Mode', 'copy'], path).then(() => true, () => false)
  $.ui.toast(isCopied ? `Путь скопирован: ${path}` : `Не удалось скопировать: ${path}`)
}

// Подготовки просмотра, идущие сейчас: повторный запрос той же картинки ждёт ту же.
const previewRuns = new Map<string, Promise<void>>()

async function hasStrips($: EngineInterface, preview: Preview): Promise<boolean> {
  const present = await Promise.all(preview.strips.map(strip => $.fs.exists(strip.path).catch(() => false)))
  return present.every(Boolean)
}

function ensurePreview($: EngineInterface, cacheDir: string, image: LibraryImage): Promise<void> {
  const key = thumbKey(image)
  const running = previewRuns.get(key)
  if (running) return running

  const run = (async () => {
    if (!THUMBABLE.includes(extensionOf(image.path))) return
    const known = (await read($, previews))[key]
    // null — формат не читается; готовый просмотр без полос на диске и сбой делаются заново.
    if (known === null || (known && 'strips' in known && (await hasStrips($, known)))) return

    const args = ['-Mode', 'preview', '-CacheDir', cacheDir, '-Size', String(PREVIEW_WIDTH), '-StripBytes', String(STRIP_BYTES)]
    try {
      const made = parseJson<Preview | null>(await runScript($, args, image.path), null)
      await update($, previews, current => ({ ...current, [key]: made }))
    } catch (failure) {
      // Сбой не помечает картинку непросматриваемой: просмотр показывает его с кнопкой «Повторить».
      const message = failure instanceof Error ? failure.message : String(failure)
      await update($, previews, current => ({ ...current, [key]: { error: message } }))
    }
  })().finally(() => previewRuns.delete(key))

  previewRuns.set(key, run)
  return run
}

async function openViewer($: EngineInterface, cacheDir: string, image: LibraryImage): Promise<void> {
  await update($, viewing, () => image.path)
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
  await ensurePreview($, cacheDir, image)
}

// Шаг по списку от картинки, открытой сейчас (а не на момент рисования).
async function stepViewer($: EngineInterface, cacheDir: string, list: readonly LibraryImage[], delta: number): Promise<void> {
  let target: LibraryImage | undefined
  await update($, viewing, current => {
    const index = list.findIndex(image => image.path === current)
    target = list[Math.min(Math.max(0, index + delta), list.length - 1)]
    return target?.path ?? current
  })
  if (target) await ensurePreview($, cacheDir, target)
}

async function closeViewer($: EngineInterface): Promise<void> {
  await update($, viewing, () => null)
}

function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
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

// Тело просмотра: полосы, мелкий исходник целиком или подсказка.
async function viewerPicture(
  $: EngineInterface,
  { Box, Button, Svg, Text }: Pick<Elements['desktop'], 'Box' | 'Button' | 'Svg' | 'Text'>,
  image: LibraryImage,
  preview: Preview | null | { error: string } | undefined,
  retry: () => Promise<void>,
): Promise<RenderElement> {
  if (preview && 'error' in preview) {
    return (
      <Box key="viewer-error" flexDirection="row" alignItems="center" gap={1}>
        <Text color="red">Не удалось подготовить просмотр: {preview.error}</Text>
        <Button key="viewer:retry" label="Повторить" onPress={retry} />
      </Box>
    )
  }

  if (preview) {
    // Полосы по ~100 КБ не кэшируются: просмотр рисуется редко, а память нужнее миниатюрам.
    const strips = await Promise.all(
      preview.strips.map(strip => $.fs.read(strip.path, { as: 'bytes' }).then(read => read.base64, () => null)),
    )
    if (strips.every(strip => strip !== null)) {
      return (
        <Box key="viewer-image" flexDirection="column">
          {preview.strips.map((strip, index) => (
            <Svg
              source={svgOf('image/jpeg', strips[index] ?? '', preview.width, strip.height)}
              alt={`${image.name} (${index + 1}/${strips.length})`}
            />
          ))}
        </Box>
      )
    }
  }

  if (preview === undefined && THUMBABLE.includes(extensionOf(image.path))) {
    return <Text dimColor>Готовлю просмотр…</Text>
  }

  const picture = await pictureOf($, image, null)
  if (picture) return <Svg source={svgOf(picture.mime, picture.base64, 800, 600)} alt={image.name} />
  return <Text dimColor>Предпросмотр этого файла недоступен — «↗ Открыть в приложении».</Text>
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
  await update($, page, () => 0)
}

async function toggleSort($: EngineInterface): Promise<void> {
  await update($, isOldestFirst, value => !value)
  await update($, page, () => 0)
}

// Переход на страницу (move — от текущей, чтобы два быстрых нажатия «›» дали два шага)
// и прокрутка к её началу, когда она уже нарисована.
async function goToPage($: EngineInterface, cacheDir: string, total: number, move: (current: number) => number): Promise<void> {
  await changeView($, cacheDir, () => update($, page, current => Math.min(Math.max(0, move(current)), pageCount(total) - 1)))
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
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
    const storedPage = await read($, page)
    const known = await read($, thumbs)
    const scanStatus = await read($, status)
    const scanError = await read($, error)
    const chosen = sortedFiltered(all, current, oldestFirst)
    const { images: shown, index: pageIndex } = pageOf(chosen, storedPage)
    const pages = pageCount(chosen.length)
    const openPage = (move: (current: number) => number) => goToPage($, cacheDir, chosen.length, move)

    // Просмотр одной картинки на всю панель; листается по текущему фильтру и сортировке.
    const viewingPath = await read($, viewing)
    const viewed = viewingPath === null ? undefined : all.find(image => image.path === viewingPath)
    if (viewed && 'Svg' in ui) {
      const inChosen = chosen.findIndex(image => image.path === viewed.path)
      const list = inChosen >= 0 ? chosen : [viewed]
      const position = Math.max(0, inChosen)
      const preview = (await read($, previews))[thumbKey(viewed)]
      const picture = await viewerPicture($, ui, viewed, preview, () => ensurePreview($, cacheDir, viewed))

      return (
        <Box flexDirection="column" gap={1}>
          <Box key="viewer-bar" flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
            <Button key="viewer:back" label="← Галерея" onPress={() => closeViewer($)} />
            <Button key="viewer:prev" label="‹" onPress={() => stepViewer($, cacheDir, list, -1)} />
            <Text>
              {position + 1} / {list.length}
            </Text>
            <Button key="viewer:next" label="›" onPress={() => stepViewer($, cacheDir, list, 1)} />
            <Button key="viewer:copy" label="📋 Копировать путь" onPress={() => copyPath($, viewed.path)} />
            <Button key="viewer:app" label="↗ Открыть в приложении" onPress={() => openFile($, viewed.path)} />
          </Box>
          <Text dimColor>
            {viewed.path} · {dateText(viewed.mtimeMs)} · {sizeText(viewed.size)}
          </Text>
          {picture}
        </Box>
      )
    }

    // Переключатель страниц: ‹ 1 … 4 5 [6] 7 8 … 40 ›; рисуется над сеткой и под ней.
    const pager = (place: string) =>
      pages > 1 && (
        <Box key={`pager:${place}`} flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
          <Button key={`${place}:prev`} label="‹" onPress={() => openPage(index => index - 1)} />
          {pageNumbers(pageIndex, pages).map((number, slot) =>
            number === null ? (
              <Text key={`${place}:gap:${slot}`} dimColor>
                …
              </Text>
            ) : (
              <Button
                key={`${place}:page:${number + 1}`}
                label={String(number + 1)}
                variant={number === pageIndex ? 'primary' : 'secondary'}
                onPress={() => openPage(() => number)}
              />
            ),
          )}
          <Button key={`${place}:next`} label="›" onPress={() => openPage(index => index + 1)} />
        </Box>
      )

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
          onPress={() => changeView($, cacheDir, () => toggleSort($))}
        />
        <Button key="refresh" label="Обновить" onPress={() => scan($, settings, cacheDir)} />
        <Text dimColor>
          {scanStatus === 'scanning'
            ? 'Сканирую…'
            : `${chosen.length} изобр.${pages > 1 ? ` · стр. ${pageIndex + 1} из ${pages}` : ''}`}
        </Text>
      </Box>
    )

    const pictures = 'Svg' in ui ? await Promise.all(shown.map(image => pictureOf($, image, known[thumbKey(image)]))) : []
    const tiles: RenderElement[] = []

    for (const [index, image] of shown.entries()) {
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
      const view = () => openViewer($, cacheDir, image)
      // Нажатие принимает только Button, не сама Svg: «🔍» лежит поверх угла картинки.
      tiles.push(
        <Box key={`tile:${image.path}`} flexDirection="column" width={26}>
          <Box key={`frame:${image.path}`} position="relative">
            {picture ? (
              <Svg source={svgOf(picture.mime, picture.base64, 176, 132)} alt={image.name} width={176} height={132} />
            ) : (
              <Box height={6} width={24} borderStyle="round" justifyContent="center" alignItems="center">
                <Text dimColor>{extensionOf(image.path).toUpperCase()}</Text>
              </Box>
            )}
            <Box position="absolute" top={0} right={0}>
              <Button key={`view:${image.path}`} plain label="🔍" onPress={view} />
            </Box>
          </Box>
          <Button key={`open:${image.path}`} plain onPress={view}>
            {shortName(image.name)}
          </Button>
          <Text dimColor>{caption}</Text>
          <Box flexDirection="row" gap={1}>
            <Button
              key={`copy:${image.path}`}
              plain
              dimColor
              label="📋 путь"
              onPress={() => copyPath($, image.path)}
            />
            <Button key={`app:${image.path}`} plain dimColor label="↗ открыть" onPress={open} />
          </Box>
        </Box>,
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {pager('top')}
        {scanStatus === 'error' && <Text color="red">Ошибка сканирования: {scanError}</Text>}
        {chosen.length === 0 && scanStatus !== 'scanning' && <Text dimColor>Изображений не найдено.</Text>}
        <Box key="grid" flexDirection={e.surface === 'terminal' ? 'column' : 'row'} flexWrap="wrap" gap={1}>
          {tiles}
        </Box>
        {pager('bottom')}
      </Box>
    )
  })
}

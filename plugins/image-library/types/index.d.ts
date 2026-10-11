// Где найдено изображение: рабочая папка проекта, папка сессии Claude Code или вывод Codex.
export type Source = 'project' | 'session' | 'codex'

export type LibraryImage = {
  path: string
  name: string
  source: Source
  // Id сессии Claude Code для source === 'session'.
  session: string | null
  size: number
  mtimeMs: number
}

// all | project | codex | sessions (все сессии) | session:<id>
export type Filter = string

// Картинка для просмотра, уменьшенная до ширины width и нарезанная на JPEG-полосы.
export type Preview = { width: number; height: number; strips: { path: string; height: number }[] }

export type ScanStatus = 'idle' | 'scanning' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'image-library': {
      images: LibraryImage[]
      status: ScanStatus
      error: string
      filter: Filter
      isOldestFirst: boolean
      // Номер страницы галереи, с нуля.
      page: number
      // «путь|mtime» изображения → путь его JPEG-миниатюры; null — миниатюру не сделать.
      thumbs: Record<string, string | null>
      // Путь картинки, открытой в просмотре; null — показана галерея.
      viewing: string | null
      // «путь|mtime» → полосы просмотра; null — формат не читается; { error } — сбой подготовки.
      previews: Record<string, Preview | null | { error: string }>
    }
  }
}

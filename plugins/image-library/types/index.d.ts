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

export type ScanStatus = 'idle' | 'scanning' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'image-library': {
      images: LibraryImage[]
      status: ScanStatus
      error: string
      filter: Filter
      isOldestFirst: boolean
      limit: number
      // Путь изображения → путь его JPEG-миниатюры; null — миниатюру не сделать.
      thumbs: Record<string, string | null>
    }
  }
}

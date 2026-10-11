# nerevar-mods

Marketplace модов Claude Code.

| Мод | Что делает |
| --- | --- |
| `turn-stats` | Полоса над полем ввода: время работы сессии, токены (включая субагентов), квота |
| `pr-merge` | Полоса с PR текущей ветки и кнопкой Merge через `gh` (настройки: `mergeMethod`, `deleteBranch`) |
| `session-progress` | Прогресс-бар задачи сессии по todo-списку и плану модели (настройка: `language`) |
| `copy-session-link` | Кнопка «🔗 Ссылка» в футере поля ввода Claude Code Desktop: копирует ссылку `claude://` на текущую сессию |
| `visual-answer-improve` | Итоговые секции ответа в цветных рамках с вкладкой-меткой: «Требуется решение» (оранжевая), «Сделано» (зелёная), «Не сделано» (мягкая красная). Правило про секции прикладывается к промптам пользователя (настройки: `decisionColor`, `doneColor`, `notDoneColor`) |
| `image-library` | Панель «Библиотека» — галерея изображений (png/jpg/webp/gif/svg) из папки проекта (без папок сборки и зависимостей: `node_modules`, `.git`, `Library`, `bin`, `dist`, `build` и т. п.), папок сессий Claude Code этого проекта и Codex (`~/.codex/generated_images`): миниатюры, фильтр по источнику и сессии, сортировка по дате, постраничная навигация; «🔍» или имя — просмотр на всю панель с листанием, «📋 путь» — полный путь к файлу в буфер обмена, «↗» — открыть в системном приложении. Открывается кнопкой «🖼 Библиотека» в футере поля ввода или командой `/library`. Только Windows: сканирование и миниатюры через PowerShell и System.Drawing, кэш в `%LOCALAPPDATA%\claude-image-library` (настройки: `includeCodex`, `scanLimit`) |

## Установка

```
/plugin marketplace add nerevar48/nerevar-mods
/plugin install turn-stats@nerevar-mods
/plugin install pr-merge@nerevar-mods
/plugin install session-progress@nerevar-mods
/plugin install copy-session-link@nerevar-mods
/plugin install visual-answer-improve@nerevar-mods
/plugin install image-library@nerevar-mods
```

Или в `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "nerevar-mods": { "source": { "source": "github", "repo": "nerevar48/nerevar-mods" } }
},
"enabledPlugins": {
  "turn-stats@nerevar-mods": true,
  "pr-merge@nerevar-mods": true,
  "session-progress@nerevar-mods": true,
  "copy-session-link@nerevar-mods": true,
  "visual-answer-improve@nerevar-mods": true,
  "image-library@nerevar-mods": true
}
```

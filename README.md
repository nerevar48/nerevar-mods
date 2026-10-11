# nerevar-mods

Marketplace модов Claude Code.

| Мод | Что делает |
| --- | --- |
| `turn-stats` | Полоса над полем ввода: время работы сессии, токены (включая субагентов), квота |
| `pr-merge` | Полоса с PR текущей ветки и кнопкой Merge через `gh` (настройки: `mergeMethod`, `deleteBranch`) |
| `session-progress` | Прогресс-бар задачи сессии по todo-списку и плану модели (настройка: `language`) |
| `copy-session-link` | Кнопка «🔗 Ссылка» в футере поля ввода Claude Code Desktop: копирует ссылку `claude://` на текущую сессию |
| `visual-answer-improve` | Итоговые секции ответа в цветных рамках с вкладкой-меткой: «Требуется решение» (оранжевая), «Сделано» (зелёная), «Не сделано» (мягкая красная). Правило про секции прикладывается к промптам пользователя (настройки: `decisionColor`, `doneColor`, `notDoneColor`) |

## Установка

```
/plugin marketplace add nerevar48/nerevar-mods
/plugin install turn-stats@nerevar-mods
/plugin install pr-merge@nerevar-mods
/plugin install session-progress@nerevar-mods
/plugin install copy-session-link@nerevar-mods
/plugin install visual-answer-improve@nerevar-mods
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
  "visual-answer-improve@nerevar-mods": true
}
```

## Разработка

Мод можно подключить из рабочей копии без установки: `CLAUDE_CODE_PLUGIN_DIRS=D:/Proj/nerevar-mods/plugins/<мод>`.
Типы для редактора генерируются локально командой `/plugin-types` в `.claude-plugin/types/` (не коммитятся).
При изменении мода поднимай `version` в его `plugin.json` и в `.claude-plugin/marketplace.json`.

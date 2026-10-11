import type { EngineInterface, Register, RenderSurface, UiPressArgument } from 'claude-code'

// Ссылка, которой Claude Code Desktop открывает свою сессию по её id.
const LINK_PREFIX = 'claude://claude.ai/epitaxy/'

// Системные утилиты буфера обмена: $.ui.copy на удалённой поверхности (desktop) не пишет.
const CLIPBOARD_COMMANDS: readonly (readonly string[])[] = [
  ['clip.exe'],
  ['pbcopy'],
  ['wl-copy'],
  ['xclip', '-selection', 'clipboard'],
]

async function copyWithSystemTool($: EngineInterface, text: string): Promise<boolean> {
  for (const argv of CLIPBOARD_COMMANDS) {
    try {
      const { exitCode } = await $.process.run(argv, { stdin: text, timeoutMs: 5000 })

      if (exitCode === 0) {
        return true
      }
    } catch {
      // Утилиты нет на этой платформе: пробуем следующую.
    }
  }

  return false
}

async function copyLink($: EngineInterface, link: string, surface: RenderSurface): Promise<void> {
  const copied = await $.ui.copy({ text: link, surface })

  if (copied.isCopied || (await copyWithSystemTool($, link))) {
    $.ui.toast('Ссылка на сессию скопирована')
  } else {
    $.ui.toast(`Не удалось скопировать: ${link}`)
  }
}

export const register: Register = on => {
  // Метки режимов в футере поля ввода: на десктопе это строка рядом с выбором модели.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    // Id сессии приложения; вне Claude Code Desktop его нет, и ссылки тоже.
    const hostSessionId = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')

    if (!hostSessionId) {
      return next(e)
    }

    const link = LINK_PREFIX + hostSessionId
    const modes = e.props.modes.join(' & ')
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Button
          key="copy-session-link"
          plain
          label="🔗 Ссылка"
          onPress={(press: UiPressArgument) => copyLink($, link, press.surface)}
        />
        {modes ? <Text dimColor> {modes}</Text> : null}
      </Box>
    )
  })
}

import type { PromptOrigin, Register } from 'claude-code'

// The closing sections a reply may carry, each drawn in a frame of its color
// under a filled tab. `ru` and `en` list the headings that open a section,
// matched case-insensitively; the first is the tab's label in that language.
type SectionKind = 'done' | 'notDone' | 'decision'

type Titles = [label: string, ...aliases: string[]]

const SECTIONS: Record<SectionKind, { ru: Titles; en: Titles; option: string }> = {
  done: { ru: ['Сделано', 'Итог'], en: ['Done', 'Summary'], option: 'doneColor' },
  notDone: { ru: ['Не сделано'], en: ['Not done'], option: 'notDoneColor' },
  decision: { ru: ['Требуется решение'], en: ['Decision needed'], option: 'decisionColor' },
}

const TAB_TEXT = '#000000'

const RULE =
  '# Closing sections of a reply\n' +
  "The user's interface draws three marked sections of a reply as colored frames. " +
  'When a turn ends with a report on the task, close the reply with these sections, in this order, ' +
  'each opened by its own level-3 heading written exactly as below, leaving out a section with nothing in it:\n' +
  '- `### Сделано` (in an English reply `### Done`): what was actually done for this task.\n' +
  '- `### Не сделано` (`### Not done`): what was asked or planned and not done, and why.\n' +
  '- `### Требуется решение` (`### Decision needed`): the points the user has to decide, as a numbered list.\n' +
  'A reply that only asks the user to decide something carries the decision section alone. ' +
  'Write nothing after the last section, and use these headings for nothing else.'

// Prompts that report on work rather than ask for it, as in session-progress:
// a denylist, since the desktop's own prompts may arrive unstamped.
const REPORTS = new Set<PromptOrigin['kind']>(['task-notification', 'peer-send-message', 'observer', 'observer-activity'])

const fromPerson = (origin: PromptOrigin | undefined): boolean =>
  !origin || (origin.kind === 'plugin' ? origin.asUser === true : !REPORTS.has(origin.kind))

// ---------------------------------------------------------------------------
// Splitting a reply's markdown into plain parts and marked sections.

type Segment = { kind: 'text'; text: string } | { kind: SectionKind; label: string; text: string }

const normalize = (s: string): string =>
  s
    .replace(/[*_`]/g, '')
    .replace(/[:：.!]+\s*$/, '')
    .trim()
    .toLowerCase()

const TITLES = new Map<string, { kind: SectionKind; label: string }>()
for (const [kind, s] of Object.entries(SECTIONS) as [SectionKind, (typeof SECTIONS)[SectionKind]][])
  for (const titles of [s.ru, s.en]) for (const t of titles) TITLES.set(normalize(t), { kind, label: titles[0] })

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const BOLD_LINE = /^ {0,3}(\*\*|__)(.+?)\1\s*:?\s*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

// A marked section runs from its heading to the next heading at its level or
// above, the next marked heading, or the end. Headings inside code fences are text.
function split(markdown: string): Segment[] {
  const out: Segment[] = []
  let kind: SectionKind | 'text' = 'text'
  let label = ''
  let level = 0
  let lines: string[] = []
  let fence = ''

  const flush = () => {
    const text = lines.join('\n').replace(/^\s*\n|\n\s*$/g, '')
    if (text.trim() || kind !== 'text') out.push(kind === 'text' ? { kind, text } : { kind, label, text })
    lines = []
  }

  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1] ?? ''
    if (fence || marker) {
      if (!fence) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
      lines.push(line)
      continue
    }
    const [, hashes = '', heading = ''] = HEADING.exec(line) ?? []
    const marked = TITLES.get(normalize(hashes ? heading : (BOLD_LINE.exec(line)?.[2] ?? '')))
    if (marked) {
      flush()
      kind = marked.kind
      label = marked.label
      level = hashes ? hashes.length : 7
      continue
    }
    if (hashes && kind !== 'text' && hashes.length <= level) {
      flush()
      kind = 'text'
    }
    lines.push(line)
  }
  flush()
  return out
}

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const color = (kind: SectionKind) => String(options[SECTIONS[kind].option])

  on('prompt.submit', ($, e, next) =>
    fromPerson(e.origin) ? next({ ...e, context: [...(e.context ?? []), RULE] }) : next(e),
  )

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.props.isSummary) return next(e)
    const segments = split(e.props.text)
    if (!segments.some(s => s.kind !== 'text')) return next(e)

    const { Box, Text, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {segments.map(s => {
          if (s.kind === 'text') return <Markdown text={s.text} />
          const c = color(s.kind)
          return (
            <Box flexDirection="column" marginTop={1}>
              <Box alignSelf="flex-start" paddingX={1} backgroundColor={c}>
                <Text color={TAB_TEXT} backgroundColor={c} bold>
                  {s.label}
                </Text>
              </Box>
              <Box flexDirection="column" borderStyle="round" borderColor={c} paddingX={1}>
                <Markdown text={s.text || ' '} />
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}

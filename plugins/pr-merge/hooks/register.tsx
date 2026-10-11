import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderNode } from 'claude-code'

import type { Checks, Pr } from '../types'

const PLUGIN = 'pr-merge'
const FIELDS = 'number,title,state,isDraft,mergeable,headRefOid,headRefName,baseRefName,statusCheckRollup'
const MERGE_TIMEOUT_MS = 120_000
const PASSED_CONCLUSIONS = ['SUCCESS', 'NEUTRAL', 'SKIPPED']

const pr = atom({ plugin: 'pr-merge', key: 'pr' } as const, null)
const phase = atom({ plugin: 'pr-merge', key: 'phase' } as const, 'idle')

// The band is shared, and the engine chains mods in no fixed order: each mod
// files its section under a rank (time 10, PR 20, progress 30), the sections
// beneath come up as one column, and the column is kept sorted by rank, the
// rest (core's own drawing) last.
const COLUMN = 'band-sections'
const SECTION = 'band-section:'
const RANK = 20

function rankOf(node: RenderNode): number {
  const key = typeof node === 'object' && node.type === 'Box' ? node.props?.key : undefined
  const rank = typeof key === 'string' && key.startsWith(SECTION) ? Number(key.slice(SECTION.length)) : NaN
  return Number.isFinite(rank) ? rank : Number.MAX_SAFE_INTEGER
}

function stacked(below: RenderElement, section: RenderElement): RenderElement {
  const rest = below.type === 'Box' && below.props?.key === COLUMN ? (below.children ?? []) : [below]
  const children = [section, ...rest].sort((a, b) => rankOf(a) - rankOf(b))
  return { type: 'Box', props: { key: COLUMN, flexDirection: 'column' }, children }
}

type Check = { __typename?: string; status?: string; conclusion?: string; state?: string }

function checkResult(check: Check): keyof Checks {
  if (check.__typename === 'CheckRun') {
    if (check.status !== 'COMPLETED') return 'pending'
    return PASSED_CONCLUSIONS.includes(check.conclusion ?? '') ? 'passed' : 'failed'
  }
  if (check.state === 'SUCCESS') return 'passed'
  if (check.state === 'PENDING' || check.state === 'EXPECTED') return 'pending'
  return 'failed'
}

function summarize(list: readonly Check[]): Checks {
  const checks: Checks = { passed: 0, failed: 0, pending: 0 }
  for (const check of list) checks[checkResult(check)] += 1
  return checks
}

// One styled run of the PR line.
type Part = { text: string; color?: string; isDim?: boolean; isBold?: boolean }

function checkParts({ passed, failed, pending }: Checks): Part[] {
  if (passed + failed + pending === 0) return [{ text: 'нет проверок', isDim: true }]
  const counts: Part[] = [{ text: `✓${passed}`, color: 'green' }]
  if (failed > 0) counts.push({ text: `✗${failed}`, color: 'red' })
  if (pending > 0) counts.push({ text: `…${pending}`, color: 'yellow' })
  return counts.flatMap((part, i) => (i === 0 ? [part] : [{ text: ' ' }, part]))
}

function prParts(current: Pr): Part[] {
  const dot: Part = { text: ' · ', isDim: true }
  return [
    { text: `PR #${current.number}`, color: 'magentaBright', isBold: true },
    { text: ` ${current.title}` },
    { text: ` → ${current.base}`, isDim: true },
    dot,
    ...checkParts(current.checks),
    ...(current.hasConflicts ? [dot, { text: 'конфликт', color: 'red' }] : []),
    ...(current.isDraft ? [dot, { text: 'черновик', color: 'yellow' }] : []),
  ]
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function refresh($: EngineInterface): Promise<Pr | null> {
  let next: Pr | null = null
  try {
    const { exitCode, stdout } = await $.process.run(['gh', 'pr', 'view', '--json', FIELDS])
    const view = exitCode === 0 ? JSON.parse(stdout) : null
    if (view?.state === 'OPEN') {
      next = {
        number: view.number,
        title: view.title,
        base: view.baseRefName,
        head: view.headRefName,
        headSha: view.headRefOid,
        isDraft: view.isDraft,
        hasConflicts: view.mergeable === 'CONFLICTING',
        checks: summarize(view.statusCheckRollup ?? []),
      }
    }
  } catch {
    // No gh, no git repo or no PR for this branch: the band stays hidden.
  }
  await update($, pr, () => next)
  return next
}

// One git step of the sync after the merge; a failure is reported and stops the sync.
async function git($: EngineInterface, args: readonly string[]): Promise<boolean> {
  try {
    const { exitCode, stderr } = await $.process.run(['git', ...args], { timeoutMs: MERGE_TIMEOUT_MS })
    if (exitCode === 0) return true
    $.ui.toast(`git ${args[0]} не удался: ${firstLine(stderr)}`)
  } catch (error) {
    $.ui.toast(`git ${args[0]} не удался: ${errorText(error)}`)
  }
  return false
}

// Tracked changes only: untracked files do not block a switch of branch.
async function hasLocalChanges($: EngineInterface): Promise<boolean> {
  const { stdout } = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=no'])
  return stdout.trim() !== ''
}

function resolvePrompt(target: Pr): string {
  return [
    `PR #${target.number} (${target.head} → ${target.base}) конфликтует с ${target.base}, подготовь его к merge.`,
    `Сделай git fetch, влей origin/${target.base} в ${target.head} и разреши конфликты, сохранив смысл изменений обеих сторон.`,
    'Проверь, что затронутый код собирается, закоммить merge и запушь ветку.',
    'Сам PR не мержь: после этого хода его смержит плагин pr-merge.',
  ].join(' ')
}

type MergeOptions = { method: string; deleteBranch: boolean }

// Merges on GitHub, then switches the checkout to the base branch and brings it up to date.
async function merge($: EngineInterface, target: Pr, { method, deleteBranch }: MergeOptions): Promise<void> {
  await update($, phase, () => 'merging')
  try {
    const argv = ['gh', 'pr', 'merge', String(target.number), `--${method}`, '--match-head-commit', target.headSha]
    if (deleteBranch) argv.push('--delete-branch')
    const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: MERGE_TIMEOUT_MS })
    if (exitCode !== 0) {
      $.ui.toast(`Merge не удался: ${firstLine(stderr)}`)
      return
    }
    const isSynced =
      (await git($, ['switch', target.base])) && (await git($, ['fetch'])) && (await git($, ['pull', '--ff-only']))
    $.ui.toast(
      isSynced
        ? `PR #${target.number} смержен, ${target.base} обновлён`
        : `PR #${target.number} смержен, но ${target.base} не обновлён`,
    )
  } catch (error) {
    $.ui.toast(`Merge не удался: ${errorText(error)}`)
  } finally {
    await update($, phase, () => 'idle')
    await refresh($)
  }
}

// The confirmed press: a conflicting PR goes to Claude first, the merge follows its turn.
async function start($: EngineInterface, options: MergeOptions): Promise<void> {
  if (await hasLocalChanges($)) {
    $.ui.toast('Есть незакоммиченные изменения: закоммить или убери их перед merge')
    await update($, phase, () => 'idle')
    return
  }
  const target = await refresh($)
  if (target === null) {
    await update($, phase, () => 'idle')
    return
  }
  if (target.hasConflicts) {
    await update($, phase, () => 'resolving')
    void $.prompt.submit({ text: resolvePrompt(target) })
    return
  }
  await merge($, target, options)
}

// After Claude's resolving turn: merge once the PR no longer conflicts, else stop.
async function resume($: EngineInterface, isAborted: boolean, options: MergeOptions): Promise<void> {
  const target = await refresh($)
  if (isAborted || target === null || target.hasConflicts || (await hasLocalChanges($))) {
    $.ui.toast('Конфликты не разрешены до конца, merge отменён')
    await update($, phase, () => 'idle')
    return
  }
  await merge($, target, options)
}

export const register: Register = (on, options) => {
  const mergeOptions: MergeOptions = {
    method: String(options.mergeMethod),
    deleteBranch: options.deleteBranch === true,
  }
  const { method } = mergeOptions

  on('session.start', async ($, e, next) => {
    // A reload ends a merge that was running; a resolving turn carries on.
    if ((await read($, phase)) === 'merging') await update($, phase, () => 'idle')
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && (await read($, phase)) === 'resolving') {
      await resume($, e.isAborted, mergeOptions)
    } else {
      await refresh($)
    }
    return result
  })

  on('ui.press', { plugin: PLUGIN }, async ($, e) => {
    if (e.element === 'refresh') await refresh($)
    if (e.element === 'merge') await update($, phase, () => 'confirm')
    if (e.element === 'cancel') await update($, phase, () => 'idle')
    if (e.element === 'confirm') await start($, mergeOptions)
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, pr)
    if (e.props.hasSurvey || current === null) {
      return next(e)
    }

    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const step = await read($, phase)
    // During a running turn the resolving prompt would queue behind it, so no merge starts then.
    const canMerge = !current.isDraft && !e.props.isWorking
    const pressed = () => undefined

    // The PR line gives way to the controls: it truncates, they keep their width.
    return stacked(
      below,
      <Box key={`${SECTION}${RANK}`} flexDirection="column">
        <Box columnGap={1}>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              {prParts(current).map(part => (
                <Text color={part.color} dimColor={part.isDim} bold={part.isBold}>
                  {part.text}
                </Text>
              ))}
            </Text>
          </Box>
          <Box flexShrink={0} columnGap={1}>
            {step === 'merging' && <Text color="yellow">мержу…</Text>}
            {step === 'resolving' && <Text color="yellow">Claude разрешает конфликты…</Text>}
            {step === 'resolving' && <Button key="cancel" label="Отмена" onPress={pressed} />}
            {step === 'confirm' && canMerge && (
              <Text>
                {current.hasConflicts ? 'Разрешить конфликты и смержить' : 'Смержить'} ({method}), затем на{' '}
                {current.base}?
              </Text>
            )}
            {step === 'confirm' && canMerge && (
              <Button key="confirm" label="Подтвердить" variant="primary" onPress={pressed} />
            )}
            {step === 'confirm' && canMerge && <Button key="cancel" label="Отмена" onPress={pressed} />}
            {step === 'idle' && canMerge && (
              <Button key="merge" label={`Merge PR #${current.number} (${method})`} variant="primary" onPress={pressed} />
            )}
            {step === 'idle' && <Button key="refresh" label="Обновить" onPress={pressed} />}
          </Box>
        </Box>
      </Box>,
    )
  })
}

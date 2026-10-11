import { describe, expect, mock, test } from 'claude-code/testing'
import type { RenderElement } from 'claude-code'

describe('copy-session-link', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: the link button keeps what the hooks beneath draw in the footer`, async ($, on) => {
      mock.env(on, { CLAUDE_CODE_HOST_SESSION_ID: 'local_1' })
      on('ui.render', ($, e) => {
        const { Text } = $.ui.resolve(e)
        return h(Text, {}, '🖼 Библиотека') as RenderElement
      })
      const ui = await $.ui.mount({ plugin: 'copy-session-link', surface, component: 'SessionMode', props: { modes: [] } })
      expect(await ui.find({ type: 'Button', key: 'copy-session-link' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '🖼 Библиотека' })).toBeDefined()
    })
  }
})

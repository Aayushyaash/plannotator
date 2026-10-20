import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInboxServer, type InboxServer } from '@plannotator/server/inbox'
import { INBOX_TOOL_ACTIONS, mcpAnswerOf, parseInboxToolList } from './inbox-contract'
import { INBOX_DEFAULT_TOOLS } from './inbox-default-tools'
import { INBOX_CARD_ACTION_ON } from '@plannotator/core/inbox-types'

/** Every action, except `card` while the Board's card action is held back (INBOX_CARD_ACTION_ON). */
const SERVED_ACTIONS = INBOX_TOOL_ACTIONS.filter((name) => name !== 'card' || INBOX_CARD_ACTION_ON)

// The failure this guards: a Claude Code session that starts before the Inbox
// ever ran registers plannotator_inbox from the bundled list, and that list
// drifted from what the Inbox actually serves (a renamed field, a new action),
// so Claude calls the Inbox with arguments it refuses.
describe('the bundled Inbox tool list', () => {
  let dataDir: string
  let inbox: InboxServer

  beforeAll(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-mod-default-tools-')))
    inbox = await startInboxServer({ dataDir, version: 'test', binaryPath: null, phones: false })
  })
  afterAll(() => {
    inbox?.stop()
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("is exactly what a real Inbox's /mcp tools/list answers (run scripts/sync-mod-inbox-tools.ts when it is not)", async () => {
    const response = await fetch(`http://127.0.0.1:${inbox.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    const served = parseInboxToolList(mcpAnswerOf(await response.text())?.result)
    expect(served.map((tool) => tool.name)).toEqual([...SERVED_ACTIONS])
    expect(JSON.parse(JSON.stringify(INBOX_DEFAULT_TOOLS))).toEqual(JSON.parse(JSON.stringify(served)))
  })
})

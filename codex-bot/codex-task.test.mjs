import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createBot } from './bot.mjs'
import { runCodex } from './codex-task.mjs'

test('reports a chat held by another Codex session without exposing diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-task-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'codex')
  const thread = '11111111-1111-7111-8111-111111111111'
  await writeFile(cli, `#!/bin/sh
cat >/dev/null
printf '%s\\n' 'Error: thread/resume: thread ${thread} already has an active writer (code -32600)' >&2
exit 1
`, { mode: 0o700 })

  const messages = []
  let receiveResult
  const result = new Promise(resolve => { receiveResult = resolve })
  const bot = createBot({
    pairedOwner: 42,
    async telegram(method, params) {
      if (method === 'sendMessage') {
        messages.push(params.text)
        if (messages.length === 2) receiveResult(params.text)
      }
      return { message_id: messages.length }
    },
    runTask: text => runCodex(cli, text, thread, { projectDir: directory }),
  })
  const send = text => bot({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text } })

  await send('Run example task')
  assert.equal(await result, 'Чат занят другой сессией Codex.\n\nВыбери другой чат через /menu.')
  await send('/status')
  assert.equal(messages.at(-1), 'Чат занят другой сессией Codex.')
})

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

test('reports only locally written task statuses even when Codex emits text and raw diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-status-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'codex')
  const marker = 'EXAMPLE_PRIVATE_OUTPUT'
  const answer = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: marker } })
  const cases = [
    {
      output: `printf '%s\\n' '${answer}' '{"type":"turn.completed"}'\nexit 0`,
      status: 'Готово. Ответ в Codex.',
    },
    {
      output: `printf '%s\\n' '${answer}' '{"type":"turn.failed","error":{"message":"unexpected status 429 ${marker}"}}'\nexit 1`,
      status: 'Сработал лимит запросов Codex. Проверь лимит в Codex и повтори задачу позже.',
    },
    {
      output: `printf '%s\\n' 'Unrecognized error with ${marker}' >&2\nexit 1`,
      status: 'Codex завершил задачу с ошибкой. Подробности проверь в Codex на Маке.',
    },
  ]
  for (const sample of cases) {
    await writeFile(cli, `#!/bin/sh\ncat >/dev/null\n${sample.output}\n`, { mode: 0o700 })
    const messages = []
    const completed = Promise.withResolvers()
    const bot = createBot({
      pairedOwner: 42,
      async telegram(method, params) {
        if (method === 'sendMessage') {
          messages.push(params.text)
          if (messages.length === 2) completed.resolve(params.text)
        }
        return { message_id: messages.length }
      },
      runTask: text => runCodex(cli, text, undefined, { projectDir: directory }),
    })
    const send = text => bot({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text } })
    await send('Run example task')
    assert.equal(await completed.promise, sample.status)
    await send('/status')
    assert.equal(messages.at(-1), sample.status)
    assert.equal(messages.some(message => message.includes(marker)), false)
  }
})

test('only the current task can be stopped by the bound owner', async () => {
  const calls = []
  const tasks = []
  const bot = createBot({
    pairedOwner: 42,
    async telegram(method, params) {
      const entry = { method, ...params, message_id: params.message_id ?? calls.length + 1 }
      calls.push(entry)
      return entry
    },
    async runTask(text, _context, _settings, signal) {
      tasks.push({ text, signal })
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      return { failure: 'cancelled' }
    },
  })
  const chat = { id: 42, type: 'private' }
  const send = text => bot({ message: { chat, from: { id: 42 }, text } })
  const tap = (message, id = 42) => bot({
    callback_query: {
      id: 'tap', from: { id }, message: { chat, message_id: message.message_id },
      data: message.reply_markup.inline_keyboard[0][0].callback_data,
    },
  })
  const lastMessage = () => calls.findLast(entry => entry.method === 'sendMessage')

  await send('First example task')
  const first = lastMessage()
  assert.equal(first.reply_markup.inline_keyboard[0][0].text, 'Остановить задачу')
  await tap(first, 13)
  assert.equal(tasks[0].signal.aborted, false)
  await tap({ ...first, message_id: first.message_id + 1 })
  assert.equal(tasks[0].signal.aborted, false)
  await tap(first)
  assert.equal(tasks[0].signal.aborted, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lastMessage().text, 'Задача остановлена.')
  assert.ok(calls.some(entry => entry.method === 'editMessageReplyMarkup'
    && entry.message_id === first.message_id && entry.reply_markup.inline_keyboard.length === 0))

  await send('Second example task')
  const second = lastMessage()
  await tap(first)
  assert.equal(tasks[1].signal.aborted, false)
  await tap(second)
  assert.equal(tasks[1].signal.aborted, true)
  await new Promise(resolve => setImmediate(resolve))
  await send('/status')
  assert.equal(lastMessage().text, 'Задача остановлена.')
})

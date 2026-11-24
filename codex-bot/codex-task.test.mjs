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

test('reports an interrupted stream without forwarding a partial answer', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-stream-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'codex')
  await writeFile(cli, `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Example partial answer"}}'
printf '%s\\n' '{"type":"turn.failed","error":{"message":"stream disconnected before completion: network error"}}'
exit 1
`, { mode: 0o700 })
  const messages = []
  const result = Promise.withResolvers()
  const bot = createBot({
    pairedOwner: 42,
    async telegram(method, params) {
      if (method === 'sendMessage') {
        messages.push(params.text)
        if (messages.length === 2) result.resolve(params.text)
      }
      return { message_id: messages.length }
    },
    runTask: text => runCodex(cli, text, undefined, { projectDir: directory }),
  })
  const send = text => bot({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text } })
  await send('Run example task')
  assert.equal(await result.promise, 'Связь с моделью Codex прервалась.\n\nОтвет остался незавершённым. Отправь исходную задачу ещё раз.')
  await send('/status')
  assert.equal(messages.at(-1), 'Связь с моделью Codex прервалась.')
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

test('releases only after the owner confirms the selected chat', async () => {
  const context = { thread: 'example-thread', title: 'Example chat', projectId: 'example-project' }
  const calls = []
  const releases = []
  const finished = Promise.withResolvers()
  const model = {
    model: 'sample', displayName: 'Example model', isDefault: true,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
  }
  const bot = createBot({
    pairedOwner: 42,
    project: { savedSelection: context, catalog: { modelOptions: async () => [model] } },
    recovery: {
      holds: async chat => chat.thread === context.thread,
      async release(chat) {
        releases.push(chat)
        await finished.promise
        return true
      },
    },
    runTask: async () => ({ failure: 'thread-busy' }),
    async telegram(method, params) {
      const entry = { method, ...params, message_id: params.message_id ?? calls.length + 1 }
      calls.push(entry)
      return entry
    },
  })
  const chat = { id: 42, type: 'private' }
  const send = text => bot({ message: { chat, from: { id: 42 }, text } })
  const tap = (message, data, id = 42) => bot({
    callback_query: { id: 'tap', from: { id }, message: { chat, message_id: message.message_id }, data },
  })
  const lastMessage = () => calls.findLast(entry => entry.method === 'sendMessage')
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const actions = message => message.reply_markup.inline_keyboard[0]

  await send('Example task')
  await settle()
  const offer = lastMessage()
  const trigger = actions(offer)[0]
  assert.equal(trigger.text, 'Освободить чат')
  await tap(offer, trigger.callback_data.replace('release:', 'release-confirm:'))
  assert.deepEqual(releases, [])

  await tap(offer, trigger.callback_data)
  const confirmation = lastMessage()
  assert.match(confirmation.text, /Example chat.*всех активных задач/)
  const [confirm, cancel] = actions(confirmation)
  await tap(confirmation, confirm.callback_data, 13)
  assert.deepEqual(releases, [])
  await tap(confirmation, cancel.callback_data)
  await tap(confirmation, confirm.callback_data)
  assert.deepEqual(releases, [])

  await send('Another example task')
  await settle()
  const nextOffer = lastMessage()
  await tap(nextOffer, actions(nextOffer)[0].callback_data)
  const nextConfirmation = lastMessage()
  await tap(nextConfirmation, actions(nextConfirmation)[0].callback_data)
  assert.deepEqual(releases, [context])
  await send('/status')
  assert.equal(lastMessage().text, 'Жду завершения задач Codex.')
  finished.resolve()
  await settle()
  assert.match(lastMessage().text, /^Чат освобождён\./)
})

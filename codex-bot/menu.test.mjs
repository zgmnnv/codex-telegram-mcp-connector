import assert from 'node:assert/strict'
import test from 'node:test'
import { createBot } from './bot.mjs'
import { createChatMenu } from './chat-menu.mjs'

const exampleModel = {
  model: 'example', displayName: 'Example model', isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
  serviceTiers: [{ id: 'priority', name: 'Fast' }],
}

test('bound owner can choose an agent, set a model, and create after confirming', async () => {
  const messages = []
  const requests = []
  const jobs = []
  let savedSelection
  let savedModels
  const owner = 42
  const firstProject = { id: 'project-a', name: 'Project A', roots: [] }
  const projects = [firstProject]
  const chats = new Map([
    [firstProject.id, [{ thread: 'a', title: 'Agent A', projectId: firstProject.id }]],
    [null, [{ thread: 'standalone', title: 'Standalone', projectId: null }]],
  ])
  const catalog = {
    projects: async () => projects,
    chats: async id => chats.get(id) || [],
    models: async () => ({ data: [exampleModel] }),
    modelOptions: async () => [exampleModel],
    async createProject(name) {
      requests.push({ type: 'project', name })
      const project = { id: 'new-project', name, roots: [] }
      projects.push(project)
      return project
    },
    async createChat(project, title) {
      requests.push({ type: 'chat', project: project.id, title })
      const chat = { thread: 'new-chat', title, projectId: project.id }
      chats.set(project.id, [chat])
      return chat
    },
  }
  const handle = createBot({
    pairingCode: 'test-pair',
    project: {
      catalog,
      saveSelection(selection) { savedSelection = selection },
      saveModels(models) { savedModels = models },
    },
    async telegram(method, params) {
      const message = { method, message_id: messages.length + 1, ...params }
      messages.push(message)
      return message
    },
    transcribe: async () => 'Test voice',
    async runTask(text, context, { model, effort, serviceTier }) {
      jobs.push({ text, thread: context.thread, model, effort, serviceTier })
      return { ok: true, text: 'Result' }
    },
  })

  const send = (text, id = owner) => handle({
    message: { from: { id }, chat: { id, type: 'private' }, message_id: 1, text },
  })
  const findButton = (message, title) => message.reply_markup?.inline_keyboard.flat().find(button => button.text === title)
  async function press(title, id = owner) {
    const message = [...messages].reverse().find(entry => findButton(entry, title))
    assert.ok(message, title)
    await handle({
      callback_query: {
        id: 'tap', data: findButton(message, title).callback_data, from: { id },
        message: { chat: { id: owner, type: 'private' }, message_id: message.message_id },
      },
    })
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))

  await send('/menu', 13)
  assert.equal(messages.length, 0)
  await send('/start test-pair')
  assert.equal(messages.at(-1).text, 'Проекты Codex')
  await press('Project A')
  assert.match(messages.at(-1).text, /Project A/)
  await send('Before choosing')
  assert.equal(jobs.length, 0)
  await press('Agent A', 13)
  assert.equal(jobs.length, 0)
  await press('Agent A')
  assert.equal(savedSelection.thread, 'a')
  await press('Модель')
  assert.match(messages.at(-1).text, /Уровень: Средний\nСкорость: Стандартная/)
  await press('Сменить модель')
  await press('Example model')
  await press('Уровень')
  await press('Высокий')
  await press('Скорость')
  await press('Fast')
  assert.match(messages.at(-1).text, /Уровень: Высокий\nСкорость: Fast/)
  assert.deepEqual(savedModels.a, { id: 'example', label: 'Example model', effort: 'high', serviceTier: 'priority' })
  await send('/menu')
  assert.equal(messages.at(-1).text, 'Проекты Codex\nАктивный чат: Agent A')
  await send('Check UI')
  await settle()
  assert.deepEqual(jobs[0], { text: 'Check UI', thread: 'a', model: 'example', effort: 'high', serviceTier: 'priority' })
  const restored = createChatMenu({ catalog, savedSelection, savedModels })
  assert.equal(restored.current().thread, 'a')
  assert.equal((await restored.settingsFor(restored.current())).serviceTier, 'priority')

  await handle({ message: { from: { id: owner }, chat: { id: owner, type: 'private' }, message_id: 3, voice: { file_id: 'fixture' } } })
  await press('✍️ Расшифровать')
  assert.equal(jobs.length, 1)

  await press('Вне проектов')
  await press('Standalone')
  await press('Отправить в Codex')
  await settle()
  assert.deepEqual(jobs[1], { text: 'Test voice', thread: 'a', model: 'example', effort: 'high', serviceTier: 'priority' })
  await send('Standalone task')
  await settle()
  assert.equal(jobs[2].thread, 'standalone')
  assert.equal(jobs[2].serviceTier, 'default')

  await send('/menu')
  assert.equal(messages.at(-1).text, 'Проекты Codex\nАктивный чат: Standalone')
  await press('Создать проект')
  await send('Test project')
  assert.deepEqual(requests, [])
  await press('Создать')
  await press('Создать чат')
  await send('Test chat')
  assert.equal(requests.length, 1)
  await press('Создать')
  assert.deepEqual(requests, [
    { type: 'project', name: 'Test project' },
    { type: 'chat', project: 'new-project', title: 'Test chat' },
  ])
  await send('Task in new chat')
  await settle()
  assert.equal(jobs[3].thread, 'new-chat')
})

test('short agent names share rows and long names keep their width', async () => {
  const project = { id: 'project-a', name: 'Project A' }
  const entries = [
    'Sample Test Agent 1',
    'Sample Test Agent 2',
    'Sample Test Agent 3',
    'Sample Test Agent 4',
    'A long descriptive agent name that needs a full-width button',
  ]
  const calls = []
  const bot = createBot({
    pairingCode: 'unused',
    pairedOwner: 42,
    project: {
      catalog: {
        projects: async () => [project],
        chats: async () => entries.map((title, i) => ({ projectId: project.id, thread: String(i), title })),
      },
    },
    async telegram(method, params) {
      const message = { method, message_id: calls.length + 1, ...params }
      calls.push(message)
      return message
    },
  })
  await bot({ message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text: '/menu' } })
  const projects = calls.at(-1)
  assert.equal(projects.text, 'Проекты Codex')
  await bot({
    callback_query: { id: 'project', from: { id: 42 }, message: screenWithChat(projects),
      data: projects.reply_markup.inline_keyboard[0][0].callback_data },
  })
  const screen = calls.at(-1)
  assert.deepEqual(screen.reply_markup.inline_keyboard.map(row => row.map(button => button.text)), [
    entries.slice(0, 2), entries.slice(2, 4), entries.slice(4), ['Создать чат'], ['← Проекты'],
  ])
  await bot({
    callback_query: { id: 'selection', from: { id: 42 }, message: screenWithChat(screen),
      data: screen.reply_markup.inline_keyboard[0][0].callback_data },
  })
  const selected = calls.at(-1)
  assert.deepEqual(selected.reply_markup.inline_keyboard[0].map(button => button.text), ['✓ ' + entries[0], entries[1]])
  assert.deepEqual(selected.reply_markup.inline_keyboard.at(-2).map(button => button.text), ['Модель', 'Создать чат'])
})

function screenWithChat(screen) {
  return { message_id: screen.message_id, chat: { id: 42, type: 'private' } }
}

test('opening projects clears a saved chat that is no longer active', async () => {
  let saved
  let title
  const menu = createChatMenu({
    catalog: { projects: async () => [], chats: async () => [] },
    savedSelection: { thread: 'old-chat', projectId: 'project-a', title: 'Old chat' },
    saveSelection(selection) { saved = selection },
    async send(text) {
      title = text
      return { message_id: 1 }
    },
  })
  await menu.open()
  assert.equal(title, 'Проекты Codex')
  assert.equal(menu.current(), undefined)
  assert.equal(saved, null)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createBot } from './bot.mjs'

test('bound owner can choose an agent, set a model, and create after confirming', async () => {
  const messages = []
  const requests = []
  const jobs = []
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
    models: async () => ({ data: [{ model: 'example', displayName: 'Example model' }] }),
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
    project: { catalog, initialProjectId: firstProject.id },
    async telegram(method, params) {
      const message = { method, message_id: messages.length + 1, ...params }
      messages.push(message)
      return message
    },
    transcribe: async () => 'Test voice',
    async runTask(text, context, model) {
      jobs.push({ text, thread: context.thread, model })
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
  assert.match(messages.at(-1).text, /Project A/)
  await send('Before choosing')
  assert.equal(jobs.length, 0)
  await press('Agent A', 13)
  assert.equal(jobs.length, 0)
  await press('Agent A')
  await press('Модель')
  await press('Example model')
  await send('Check UI')
  await settle()
  assert.deepEqual(jobs[0], { text: 'Check UI', thread: 'a', model: 'example' })
  await handle({ message: { from: { id: owner }, chat: { id: owner, type: 'private' }, message_id: 3, voice: { file_id: 'fixture' } } })
  await press('✍️ Расшифровать')
  assert.equal(jobs.length, 1)

  await press('← Проекты')
  await press('Вне проектов')
  await press('Standalone')
  await press('Отправить в Codex')
  await settle()
  assert.deepEqual(jobs[1], { text: 'Test voice', thread: 'a', model: 'example' })
  await send('Standalone task')
  await settle()
  assert.equal(jobs[2].thread, 'standalone')

  await press('← Проекты')
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

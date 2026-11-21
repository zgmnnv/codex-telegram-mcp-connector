import { randomBytes, randomUUID } from 'node:crypto'

const limit = 8
const short = (text, length = 50) => Array.from(text).slice(0, length).join('')
const choice = (label, run) => ({ label, run })

export function createChatMenu({ catalog, initialProjectId, send, edit, savedModels = {}, saveModels = () => {} }) {
  let scope
  let selected
  let pending
  let messageId
  let buttons = new Map()
  const models = new Map(Object.entries(savedModels))
  const modelFor = context => context && models.get(context.thread)

  const scopeName = () => scope?.name || 'Вне проектов'

  async function screen(title, rows) {
    const actions = new Map()
    const inline_keyboard = rows.map(({ label, run }) => {
      const id = `menu:${randomBytes(8).toString('hex')}`
      actions.set(id, run)
      return [{ text: short(label, 60), callback_data: id }]
    })
    const markup = { inline_keyboard }
    if (messageId) await edit(messageId, title, markup)
    else messageId = (await send(title, { reply_markup: markup })).message_id
    buttons = actions
  }

  function pagination(rows, amount, page, render) {
    if (page > 0) rows.push(choice('← Предыдущая страница', () => render(page - 1)))
    if ((page + 1) * limit < amount) rows.push(choice('Следующая страница →', () => render(page + 1)))
  }

  async function projects(page = 0) {
    scope = undefined
    selected = undefined
    pending = undefined
    const data = await catalog.projects()
    const rows = data.slice(page * limit, (page + 1) * limit).map(project => choice(project.name, async () => {
      scope = project
      await chats()
    }))
    pagination(rows, data.length, page, projects)
    rows.push(choice('Вне проектов', async () => {
      scope = null
      await chats()
    }), choice('Создать проект', () => begin('project')))
    await screen('Проекты Codex', rows)
  }

  async function chats(page = 0) {
    pending = undefined
    const data = await catalog.chats(scope?.id ?? null)
    if (selected && !data.some(entry => entry.thread === selected.thread)) selected = undefined
    const rows = data.slice(page * limit, (page + 1) * limit).map(entry => choice(
      (selected?.thread === entry.thread ? '✓ ' : '') + entry.title,
      async () => {
        selected = entry
        await chats(page)
      },
    ))
    pagination(rows, data.length, page, chats)
    if (selected) rows.push(choice('Модель', () => modelPage()))
    rows.push(choice('Создать чат', () => begin('chat')), choice('← Проекты', () => projects()))
    const subtitle = selected
      ? `Чат: ${short(selected.title, 120)}\nМодель: ${modelFor(selected)?.label || 'По умолчанию'}`
      : data.length ? 'Выбери активный чат.' : 'Активных чатов пока нет.'
    await screen(`${scopeName()}\n${subtitle}`, rows)
  }

  async function chooseModel(model) {
    if (model) models.set(selected.thread, model)
    else models.delete(selected.thread)
    await saveModels(Object.fromEntries(models))
    await chats()
  }

  async function modelPage(cursor) {
    const page = await catalog.models(cursor)
    const rows = page.data.map(model => choice(model.displayName, () => chooseModel({ id: model.model, label: model.displayName })))
    if (page.nextCursor) rows.push(choice('Следующая страница →', () => modelPage(page.nextCursor)))
    rows.push(choice('По умолчанию', () => chooseModel()), choice('← К чатам', () => chats()))
    await screen(`Модель для «${short(selected.title, 120)}»`, rows)
  }

  const back = () => scope === undefined ? projects() : chats()

  async function begin(kind) {
    pending = { kind, requestId: randomUUID() }
    await screen(kind === 'project' ? 'Напиши название проекта.' : `Напиши название чата в «${scopeName()}».`, [choice('Отмена', back)])
  }

  async function acceptTitle(text) {
    if (!pending) return false
    if (pending.title) {
      await send('Подтверди создание кнопкой или выбери «Отмена».')
      return true
    }
    if (Array.from(text).length > 80 || /[\p{Cc}\p{Cf}]/u.test(text)) {
      await send('Введи название одной строкой, до 80 символов.')
      return true
    }
    const draft = { ...pending, title: text }
    pending = draft
    const type = draft.kind === 'project' ? 'проект' : 'чат'
    await screen(`Создать ${type} «${text}»?`, [
      choice('Создать', async () => {
        if (pending !== draft) return
        if (draft.kind === 'project') {
          scope = await catalog.createProject(text, draft.requestId)
          selected = undefined
        } else {
          selected = await catalog.createChat(scope, text)
        }
        pending = undefined
        await send(`Создан ${type} «${draft.kind === 'project' ? scope.name : selected.title}».`)
        await chats()
      }),
      choice('Отмена', back),
    ])
    return true
  }

  return {
    async open() {
      messageId = undefined
      pending = undefined
      if (scope === undefined && initialProjectId) {
        const list = await catalog.projects()
        scope = list.find(project => project.id === initialProjectId)
        initialProjectId = undefined
      }
      if (scope === undefined) await projects()
      else await chats()
    },
    action(callback) {
      if (callback.message?.message_id === messageId) return buttons.get(callback.data)
    },
    current: () => selected,
    waitingForTitle: () => Boolean(pending),
    acceptTitle,
    modelFor,
  }
}

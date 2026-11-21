import { randomBytes, randomUUID } from 'node:crypto'

const limit = 8
const short = (text, length = 50) => Array.from(text).slice(0, length).join('')
const choice = (label, run) => ({ label, run })
const labelLength = ({ label }) => Array.from(label.replace(/^✓ /, '')).length
const effortLabels = {
  none: 'Без рассуждений', minimal: 'Минимальный', low: 'Низкий',
  medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимальный', ultra: 'Ultra',
}
const standardSpeed = { id: 'default', name: 'Стандартная' }

export function modelSummary({ label, effort, serviceTier, speeds }) {
  return `Модель: ${label}\nУровень: ${effortLabels[effort] || effort}\nСкорость: ${speeds.find(speed => speed.id === serviceTier)?.name || serviceTier}`
}

function choiceRows(choices) {
  const rows = []
  for (const item of choices) {
    const last = rows.at(-1)
    if (last?.length === 1 && labelLength(last[0]) <= 20 && labelLength(item) <= 20
      && labelLength(last[0]) + labelLength(item) <= 38) {
      last.push(item)
    } else {
      rows.push([item])
    }
  }
  return rows
}

export function createChatMenu({
  catalog, send, edit, savedModels = {}, saveModels = () => {},
  savedSelection, saveSelection = () => {},
}) {
  let scope
  let selected = savedSelection
  let pending
  let messageId
  let buttons = new Map()
  const models = new Map(Object.entries(savedModels))
  const modelFor = context => context && models.get(context.thread)

  const scopeName = () => scope?.name || 'Вне проектов'
  const selectionText = () => selected ? `Активный чат: ${short(selected.title, 120)}` : ''

  async function select(context) {
    await saveSelection(context ?? null)
    selected = context
  }

  async function refreshSelection(data) {
    if (!selected) return
    const chats = data ?? await catalog.chats(selected.projectId)
    const match = chats.find(chat => chat.thread === selected.thread)
    if (!match || match.title !== selected.title) await select(match)
  }

  async function settingsFor(context) {
    const preferred = modelFor(context)
    const options = await catalog.modelOptions()
    const match = options.find(item => item.model === preferred?.id)
    const model = match ?? options.find(item => item.isDefault) ?? options[0]
    if (!model) throw new Error('Codex не вернул доступные модели.')
    const efforts = model.supportedReasoningEfforts.map(item => item.reasoningEffort)
    const speeds = [standardSpeed, ...(model.serviceTiers || []).filter(item => item.id !== standardSpeed.id)]
    const previous = match || !preferred?.id ? preferred : undefined
    return {
      model: model.model,
      label: model.displayName,
      effort: efforts.includes(previous?.effort) ? previous.effort : model.defaultReasoningEffort,
      serviceTier: speeds.some(item => item.id === previous?.serviceTier) ? previous.serviceTier : standardSpeed.id,
      efforts, speeds,
    }
  }

  async function screen(title, rows) {
    const actions = new Map()
    const inline_keyboard = rows.map(row => row.map(({ label, run }) => {
      const id = `menu:${randomBytes(8).toString('hex')}`
      actions.set(id, run)
      return { text: short(label, 60), callback_data: id }
    }))
    const markup = { inline_keyboard }
    if (messageId) await edit(messageId, title, markup)
    else messageId = (await send(title, { reply_markup: markup })).message_id
    buttons = actions
  }

  function pagination(rows, amount, page, render) {
    const navigation = []
    if (page > 0) navigation.push(choice('← Назад', () => render(page - 1)))
    if ((page + 1) * limit < amount) navigation.push(choice('Дальше →', () => render(page + 1)))
    if (navigation.length) rows.push(navigation)
  }

  async function projects(page = 0) {
    scope = undefined
    pending = undefined
    const data = await catalog.projects()
    const choices = data.slice(page * limit, (page + 1) * limit).map(project => choice(project.name, async () => {
      scope = project
      await chats()
    }))
    const rows = choiceRows(choices)
    pagination(rows, data.length, page, projects)
    rows.push([choice('Вне проектов', async () => {
      scope = null
      await chats()
    }), choice('Создать проект', () => begin('project'))])
    if (selected) rows.push([choice('Настройки активного чата', settingsPage)])
    await screen(['Проекты Codex', selectionText()].filter(Boolean).join('\n'), rows)
  }

  async function chats(page = 0) {
    pending = undefined
    const scopeId = scope?.id ?? null
    const data = await catalog.chats(scopeId)
    const selectedHere = selected?.projectId === scopeId
    if (selectedHere) await refreshSelection(data)
    const choices = data.slice(page * limit, (page + 1) * limit).map(entry => choice(
      (selected?.thread === entry.thread ? '✓ ' : '') + entry.title,
      async () => {
        await select(entry)
        await chats(page)
      },
    ))
    const rows = choiceRows(choices)
    pagination(rows, data.length, page, chats)
    const actions = [choice('Создать чат', () => begin('chat'))]
    if (selected && selectedHere) actions.unshift(choice('Модель', settingsPage))
    rows.push(actions, [choice('← Проекты', () => projects())])
    const subtitle = selected && selectedHere
      ? `${selectionText()}\nМодель: ${modelFor(selected)?.label || 'По умолчанию'}`
      : [selectionText(), data.length ? 'Выбери чат.' : 'Активных чатов пока нет.'].filter(Boolean).join('\n')
    await screen(`${scopeName()}\n${subtitle}`, rows)
  }

  async function saveSettings(values) {
    await saveModels({ ...Object.fromEntries(models), [selected.thread]: values })
    models.set(selected.thread, values)
    await settingsPage()
  }

  async function settingsPage() {
    const settings = await settingsFor(selected)
    await screen(`Чат: ${short(selected.title, 120)}\n${modelSummary(settings)}`, [
      [choice('Сменить модель', () => modelPage()), choice('Уровень', () => effortPage(settings))],
      [choice('Скорость', () => speedPage(settings)), choice('← Назад', back)],
    ])
  }

  function selectedOption(label, isSelected) {
    return isSelected ? `✓ ${label}` : label
  }

  async function effortPage(settings) {
    const rows = choiceRows(settings.efforts.map(effort => choice(
      selectedOption(effortLabels[effort] || effort, effort === settings.effort),
      () => saveSettings({ ...modelFor(selected), effort }),
    )))
    rows.push([choice('← К настройкам', settingsPage)])
    await screen(`Уровень рассуждений\n${settings.label}`, rows)
  }

  async function speedPage(settings) {
    const rows = choiceRows(settings.speeds.map(speed => choice(
      selectedOption(speed.name, speed.id === settings.serviceTier),
      () => saveSettings({ ...modelFor(selected), serviceTier: speed.id }),
    )))
    rows.push([choice('← К настройкам', settingsPage)])
    const note = settings.speeds.length > 1 ? '\nУскорение расходует больше лимита.' : ''
    await screen(`Скорость\n${settings.label}${note}`, rows)
  }

  async function modelPage(cursor) {
    const page = await catalog.models(cursor)
    const rows = choiceRows(page.data.map(model => choice(model.displayName, () => {
      const previous = modelFor(selected)
      return saveSettings(previous?.id === model.model ? previous : { id: model.model, label: model.displayName })
    })))
    if (page.nextCursor) {
      const navigation = [choice('Дальше →', () => modelPage(page.nextCursor))]
      if (cursor) navigation.unshift(choice('← К началу', () => modelPage()))
      rows.push(navigation)
    } else if (cursor) {
      rows.push([choice('← К началу', () => modelPage())])
    }
    rows.push([choice('По умолчанию', () => saveSettings({})), choice('← К настройкам', settingsPage)])
    await screen(`Модель для «${short(selected.title, 120)}»`, rows)
  }

  const back = () => scope === undefined ? projects() : chats()

  async function begin(kind) {
    pending = { kind, requestId: randomUUID() }
    await screen(kind === 'project' ? 'Напиши название проекта.' : `Напиши название чата в «${scopeName()}».`, [[choice('Отмена', back)]])
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
    await screen(`Создать ${type} «${text}»?`, [[
      choice('Создать', async () => {
        if (pending !== draft) return
        if (draft.kind === 'project') {
          scope = await catalog.createProject(text, draft.requestId)
        } else {
          await select(await catalog.createChat(scope, text))
        }
        pending = undefined
        await send(`Создан ${type} «${draft.kind === 'project' ? scope.name : selected.title}».`)
        await chats()
      }),
      choice('Отмена', back),
    ]])
    return true
  }

  return {
    async open() {
      messageId = undefined
      await refreshSelection()
      await projects()
    },
    action(callback) {
      if (callback.message?.message_id === messageId) return buttons.get(callback.data)
    },
    current: () => selected,
    waitingForTitle: () => Boolean(pending),
    acceptTitle,
    settingsFor,
  }
}

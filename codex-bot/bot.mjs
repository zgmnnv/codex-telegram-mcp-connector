import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createChatMenu, modelSummary } from './chat-menu.mjs'
import { createCatalog } from './codex-catalog.mjs'
import { runCodex } from './codex-task.mjs'
import { VoiceError, voiceTranscriber } from './voice.mjs'

function telegramClient(token) {
  return async (method, params = {}) => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      redirect: 'error',
      signal: AbortSignal.timeout(40_000),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) {
      throw Object.assign(new Error('Ошибка Telegram Bot API'), {
        status: data.error_code ?? response.status,
        retryAfter: data.parameters?.retry_after,
      })
    }
    return data.result
  }
}

export function createBot({ telegram, transcribe, runTask, pairingCode, project, pairedOwner, saveOwner = () => {} }) {
  let owner = pairedOwner
  let active = false
  let status = 'Заданий пока нет.'
  const drafts = new Map()
  const threads = new Map()

  const send = (text, options) => telegram('sendMessage', { chat_id: owner, text, ...options })
  const button = (text, data) => ({
    reply_markup: { inline_keyboard: [[{ text, callback_data: data }]] },
  })
  const acknowledge = (id, text) => telegram('answerCallbackQuery', { callback_query_id: id, text }).catch(() => {})
  const fromOwner = message => Number.isInteger(owner) && message?.chat?.type === 'private' && message.chat.id === owner
  const menu = project && createChatMenu({
    ...project,
    send,
    edit: (message_id, text, reply_markup) => telegram('editMessageText', { chat_id: owner, message_id, text, reply_markup }),
  })

  async function sendResult(prefix, text, context) {
    const parts = Array.from(text || prefix)
    for (let i = 0; i < parts.length; i += 1900) {
      const part = parts.slice(i, i + 1900).join('')
      const message = await send(i === 0 && text ? `${prefix}\n\n${part}` : part)
      if (context?.thread) threads.set(message.message_id, context)
    }
    while (threads.size > 100) threads.delete(threads.keys().next().value)
  }

  function startTask(text, context) {
    active = true
    status = 'В работе.'
    void (async () => {
      try {
        const settings = await menu?.settingsFor(context)
        const details = settings ? `\nЧат: ${context.title}\n${modelSummary(settings)}` : ''
        status = 'В работе.' + details
        await send('Принято. Запускаю Codex.' + details)
        const result = await runTask(text, context, settings)
        status = result.ok ? 'Готово.' : 'Codex завершил задачу с ошибкой.'
        const description = result.text || (result.ok ? '' : 'Проверь вход в Codex и состояние проекта на Маке. Задание можно отправить ещё раз.')
        await sendResult(status, description, context)
      } catch {
        status = 'Не удалось выполнить задачу или доставить результат.'
        await send(status).catch(() => {})
      } finally {
        active = false
      }
    })()
  }

  async function handleCallback(callback) {
    if (!fromOwner(callback.message) || callback.from?.id !== owner) return
    const [action, id] = (callback.data || '').split(':')
    if (action === 'menu') {
      const choose = menu?.action(callback)
      if (!choose) return acknowledge(callback.id, 'Открой /menu ещё раз.')
      await acknowledge(callback.id)
      try {
        await choose()
      } catch {
        await send('Не удалось обновить меню Codex. Открой /menu ещё раз.')
      }
      return
    }
    const draft = drafts.get(id)
    if (!draft) return acknowledge(callback.id, 'Пришли голосовое ещё раз.')
    if (action === 'task') {
      if (!draft.text || draft.submitted) return acknowledge(callback.id, 'Этот текст уже использован или недоступен.')
      if (active) return acknowledge(callback.id, 'Дождись текущей задачи и нажми ещё раз.')
      const context = draft.context ?? menu?.current()
      if (menu && !context?.thread) return acknowledge(callback.id, 'Выбери чат в /menu, затем нажми ещё раз.')
      draft.submitted = true
      startTask(draft.text, context)
      return acknowledge(callback.id)
    }
    if (action !== 'voice') return acknowledge(callback.id)
    if (draft.text) return acknowledge(callback.id, 'Расшифровка уже в чате.')
    await acknowledge(callback.id, 'Расшифровываю…')
    try {
      const text = await transcribe(draft.voice)
      const chars = Array.from(text)
      for (let i = 0; i < chars.length; i += 1900) {
        await send(chars.slice(i, i + 1900).join(''))
      }
      const target = draft.context ? `\nЧат: ${draft.context.title}`
        : menu ? '\nВыбери чат в /menu перед отправкой.' : ''
      await send('Проверь расшифровку. Можно отправить её в Codex или прислать исправленный текст.' + target, button('Отправить в Codex', `task:${id}`))
      draft.text = text
    } catch (error) {
      await send(error instanceof VoiceError ? error.message : 'Не удалось расшифровать голосовое. Нажми ✍️, чтобы повторить.')
    }
  }

  return async function handle(update) {
    if (update.callback_query) return handleCallback(update.callback_query)

    const message = update.message
    if (message?.chat?.type !== 'private') return
    if (owner === undefined && message.text === `/start ${pairingCode}` && message.from?.id === message.chat.id) {
      await saveOwner(message.from.id)
      owner = message.from.id
      if (!menu) return send('Подключено. Пришли голосовое или напиши задачу для Codex.')
      await telegram('setMyCommands', {
        scope: { type: 'chat', chat_id: owner },
        commands: [
          { command: 'menu', description: 'Проекты, чаты и модели Codex' },
          { command: 'status', description: 'Статус задачи' },
        ],
      }).catch(() => {})
      await send('Подключено. Открываю меню Codex.')
      return menu.open()
    }
    if (!fromOwner(message) || message.from?.id !== owner) return
    if (menu && ['/start', '/menu'].includes(message.text)) return menu.open()
    if (message.text === '/start') return send('Пришли голосовое или напиши задачу для Codex. Команда /status покажет статус.')
    if (message.text === '/status') return send(status)

    const context = threads.get(message.reply_to_message?.message_id) ?? menu?.current()
    if (message.voice) {
      if (menu?.waitingForTitle()) return send('Введи название текстом или нажми «Отмена».')
      const id = randomBytes(12).toString('hex')
      drafts.set(id, { voice: message.voice, context })
      if (drafts.size > 30) drafts.delete(drafts.keys().next().value)
      return send('Расшифровать это голосовое?', {
        ...button('✍️ Расшифровать', `voice:${id}`),
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      })
    }
    if (message.text?.startsWith('/')) return send(menu
      ? 'Используй /menu для выбора чата и /status для проверки задачи.'
      : 'Используй /status или пришли задачу обычным сообщением.')
    const text = message.text?.trim()
    if (text && await menu?.acceptTitle(text)) return
    if (text && active) return send('Сейчас выполняется другая задача. Пришли сообщение ещё раз, когда она завершится.')
    if (text && menu && !context?.thread) return send('Выбери чат в /menu и отправь задачу.')
    if (text) startTask(text, context)
  }
}

function localState(token) {
  const directory = new URL('./private/', import.meta.url)
  const name = createHash('sha256').update(token).digest('hex').slice(0, 20)
  const file = new URL(`bot-${name}.json`, directory)
  function readJson(url, fallback) {
    try {
      return JSON.parse(readFileSync(url, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return fallback
    }
  }
  let state = readJson(file, {})
  return {
    owner: Number.isSafeInteger(state.owner) && state.owner > 0 ? state.owner : undefined,
    models: state.models || {},
    selection: state.selection || undefined,
    save(key, value) {
      const updated = { ...state, [key]: value }
      mkdirSync(directory, { mode: 0o700, recursive: true })
      const temporary = new URL(`bot-${randomBytes(8).toString('hex')}.tmp`, directory)
      writeFileSync(temporary, JSON.stringify(updated) + '\n', { mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
      state = updated
    },
  }
}

async function main() {
  const config = JSON.parse(readFileSync(0, 'utf8'))
  const workspace = realpathSync(config.workspace || fileURLToPath(new URL('../', import.meta.url)))
  const catalog = createCatalog(config.codexPath, workspace)
  const state = localState(config.token)
  const project = {
    catalog, savedModels: state.models,
    saveModels: models => state.save('models', models),
    savedSelection: state.selection,
    saveSelection: selection => state.save('selection', selection),
  }
  const telegram = telegramClient(config.token)
  const pairingCode = randomBytes(8).toString('hex')
  const bot = await telegram('getMe')
  console.log(state.owner
    ? `@${bot.username} запущен. Команда /menu откроет проекты.`
    : `Открой @${bot.username} и отправь /start ${pairingCode}`)
  const handle = createBot({
    telegram,
    pairingCode,
    pairedOwner: state.owner,
    saveOwner: owner => state.save('owner', owner),
    transcribe: voiceTranscriber(config, telegram),
    project,
    async runTask(text, context, settings) {
      const projectDir = context?.thread && await catalog.resumePath(context)
      if (!projectDir) return { ok: false, text: 'Чат занят или недоступен. Выбери активный чат в /menu.' }
      const { model, effort, serviceTier } = settings
      return runCodex(config.codexPath, text, context.thread, { projectDir, model, effort, serviceTier })
    },
  })
  let offset = 0
  for (;;) {
    try {
      const updates = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] })
      for (const update of updates) {
        offset = update.update_id + 1
        await handle(update).catch(() => console.error('Не удалось обработать обновление Telegram.'))
      }
    } catch (error) {
      if ([401, 404, 409].includes(error.status)) throw error
      console.error('Нет связи с Telegram. Повторяю подключение.')
      await sleep(1000 * (error.retryAfter || 3))
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.status === 409
      ? 'У бота уже есть подключение. Останови другой процесс бота или отключи его вебхук.'
      : 'Не удалось запустить бота. Проверь токен Telegram и доступ в интернет.')
    process.exitCode = 1
  })
}

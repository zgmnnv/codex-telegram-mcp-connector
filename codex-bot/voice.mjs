import { transcribeSpeechKit, VoiceError } from './speechkit.mjs'

const providers = {
  groq: {
    url: 'https://api.groq.com/openai/v1/audio/transcriptions',
    model: 'whisper-large-v3-turbo',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/audio/transcriptions',
    model: 'openai/whisper-large-v3-turbo',
  },
}

export { VoiceError }

export function voiceTranscriber({ token, provider, apiKey }, telegram) {
  const maxBytes = 20 * 1024 * 1024

  return async function transcribe(voice) {
    const tooLarge = 'Голосовое больше 20 МБ. Отправь его более короткими частями.'
    if (voice.file_size > maxBytes) throw new VoiceError(tooLarge)
    const file = await telegram('getFile', { file_id: voice.file_id })
    if (file.file_size > maxBytes) throw new VoiceError(tooLarge)
    if (!file.file_path || file.file_path.split('/').some(part => !/^[\w.-]+$/.test(part) || part === '..' || part === '.')) {
      throw new VoiceError('Telegram не вернул путь к голосовому.')
    }
    const path = file.file_path.split('/').map(encodeURIComponent).join('/')
    const download = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (!download.ok) throw new VoiceError('Не удалось скачать голосовое из Telegram.')
    const bytes = await download.arrayBuffer()
    if (bytes.byteLength > maxBytes) throw new VoiceError(tooLarge)
    const format = path.endsWith('.mp3') ? 'mp3' : path.endsWith('.m4a') ? 'm4a' : 'ogg'
    if (provider === 'yandex') {
      const text = await transcribeSpeechKit(apiKey, bytes, format)
      if (text) return text
      throw new VoiceError('Распознать речь не удалось. Попробуй записать голосовое ещё раз.')
    }
    const { url, model } = providers[provider]
    const audio = new Blob([bytes], { type: { ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4' }[format] })
    const body = new FormData()
    body.set('file', audio, `voice.${format}`)
    body.set('model', model)
    body.set('response_format', 'json')
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
    })
    if (response.status === 401 || response.status === 403) throw new VoiceError('Проверь ключ транскрибации в терминале.')
    if (response.status === 429) throw new VoiceError('Сервис транскрибации достиг лимита. Попробуй ещё раз позже.')
    if (!response.ok) throw new VoiceError('Сервис транскрибации не принял голосовое.')
    const text = (await response.json()).text?.trim()
    if (!text) throw new VoiceError('Распознать речь не удалось. Попробуй записать голосовое ещё раз.')
    return text
  }
}

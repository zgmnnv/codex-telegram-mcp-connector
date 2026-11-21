import { transcribeSpeechKit, VoiceError } from './speechkit.mjs'

export { VoiceError }

export function voiceTranscriber({ token, apiKey }, telegram) {
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
    const suffix = path.split('.').at(-1)?.toLowerCase()
    const format = suffix === 'oga' ? 'ogg' : suffix
    const text = await transcribeSpeechKit(apiKey, bytes, format)
    if (!text) throw new VoiceError('Распознать речь не удалось. Попробуй записать голосовое ещё раз.')
    return text
  }
}

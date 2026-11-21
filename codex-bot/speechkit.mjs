import { setTimeout as sleep } from 'node:timers/promises'

export class VoiceError extends Error {}

export async function transcribeSpeechKit(apiKey, bytes, format) {
  const containerAudioType = { ogg: 'OGG_OPUS', mp3: 'MP3', wav: 'WAV' }[format]
  if (!containerAudioType) throw new VoiceError('Пришли обычное голосовое Telegram в формате Ogg Opus.')
  const recognitionUrl = 'https://stt.api.cloud.yandex.net/stt/v3'
  const request = async (url, body) => {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Api-Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 401 || response.status === 403) {
      throw new VoiceError('SpeechKit отклонил доступ. Проверь ключ и роль ai.speechkit-stt.user.')
    }
    if (response.status === 429) throw new VoiceError('SpeechKit достиг лимита. Попробуй позже.')
    if (!response.ok) throw new VoiceError('SpeechKit не принял запрос распознавания.')
    return response
  }

  const started = await request(`${recognitionUrl}/recognizeFileAsync`, {
    content: Buffer.from(bytes).toString('base64'),
    recognitionModel: { model: 'general', audioFormat: { containerAudio: { containerAudioType } } },
  })
  let operation = await started.json()
  if (!operation.id) throw new VoiceError('SpeechKit не вернул идентификатор распознавания.')
  const id = encodeURIComponent(operation.id)
  const deadline = Date.now() + 180_000
  while (!operation.done) {
    if (Date.now() >= deadline) throw new VoiceError('SpeechKit ещё обрабатывает голосовое. Попробуй более короткую запись.')
    await sleep(1500)
    const response = await request(`https://operation.api.cloud.yandex.net/operations/${id}`)
    operation = await response.json()
  }
  if (operation.error) throw new VoiceError('SpeechKit завершил распознавание с ошибкой.')

  const response = await request(`${recognitionUrl}/getRecognition?operation_id=${id}`)
  const body = (await response.text()).trim()
  if (!body) return ''
  let events
  try {
    events = [JSON.parse(body)].flat()
  } catch {
    events = body.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  }
  const segments = new Map()
  for (const { result } of events) {
    if (!result) continue
    const final = result.final?.alternatives?.[0]?.text
    const refined = result.finalRefinement?.normalizedText?.alternatives?.[0]?.text
    if (final) segments.set(String(result.audioCursors?.finalIndex ?? segments.size), final)
    if (refined) segments.set(String(result.finalRefinement.finalIndex), refined)
  }
  return [...segments.values()].join(' ').trim()
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { voiceTranscriber } from './voice.mjs'

test('Telegram voice goes directly to Yandex SpeechKit', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options })
    if (requests.length === 1) return new Response('OggS test')
    if (requests.length === 2) return Response.json({ id: 'example', done: true })
    return Response.json({ result: { final: { alternatives: [{ text: 'Проверка' }] } } })
  })
  const transcribe = voiceTranscriber({ token: 'example', apiKey: 'example' }, async (method, params) => {
    assert.equal(method, 'getFile')
    assert.equal(params.file_id, 'example')
    return { file_path: 'voice/example.oga' }
  })
  assert.equal(await transcribe({ file_id: 'example' }), 'Проверка')
  assert.deepEqual(requests.map(entry => new URL(entry.url).hostname), [
    'api.telegram.org', 'stt.api.cloud.yandex.net', 'stt.api.cloud.yandex.net',
  ])
  const payload = JSON.parse(requests[1].options.body)
  assert.equal(payload.recognitionModel.audioFormat.containerAudio.containerAudioType, 'OGG_OPUS')
  assert.equal(requests[1].options.headers.Authorization, 'Api-Key example')
})

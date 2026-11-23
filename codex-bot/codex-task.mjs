import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../', import.meta.url))

export async function runCodex(codexPath, prompt, previousThread, {
  projectDir = project, model, effort, serviceTier, signal,
} = {}) {
  if (signal?.aborted) return { thread: previousThread, ok: false, text: '', failure: 'cancelled' }

  const args = [
    '--no-daemon', '--cd', projectDir,
    '--sandbox', 'read-only', '--ask-for-approval', 'never',
    '--config', 'features.apps=false', '--config', 'mcp_servers={}',
  ]
  if (effort) args.push('--config', `model_reasoning_effort=${JSON.stringify(effort)}`)
  if (serviceTier) args.push('--config', `service_tier=${JSON.stringify(serviceTier)}`)
  if (serviceTier && serviceTier !== 'default') args.push('--config', 'features.fast_mode=true')
  args.push('exec')
  if (previousThread) args.push('resume', previousThread)
  if (model) args.push('--model', model)
  args.push('--ignore-user-config', '--json', '-')

  const child = spawn(codexPath, args, { cwd: projectDir, stdio: ['pipe', 'pipe', 'pipe'] })
  const finished = once(child, 'close').catch(() => [null])
  let interrupted = false
  let forceStop
  const interrupt = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    interrupted = child.kill('SIGINT')
    if (interrupted) forceStop = setTimeout(() => child.kill('SIGKILL'), 5_000)
  }
  signal?.addEventListener('abort', interrupt, { once: true })
  let threadBusy = false
  const diagnostics = createInterface({ input: child.stderr })
  diagnostics.on('line', line => {
    if (previousThread && line.includes(`thread ${previousThread} already has an active writer`)) {
      threadBusy = true
    }
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

  let thread = previousThread
  let completed = false
  let text = ''
  const lines = createInterface({ input: child.stdout })
  for await (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'thread.started' && /^[0-9a-f-]{36}$/i.test(event.thread_id)) thread = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text
    if (event.type === 'turn.completed') completed = true
  }
  const [code] = await finished
  clearTimeout(forceStop)
  signal?.removeEventListener('abort', interrupt)
  const ok = code === 0 && completed
  if (!ok && threadBusy) return { thread, ok: false, text, failure: 'thread-busy' }
  if (!ok && interrupted) return { thread, ok: false, text: '', failure: 'cancelled' }
  return { thread, ok, text }
}

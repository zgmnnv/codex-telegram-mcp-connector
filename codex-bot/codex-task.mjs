import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../', import.meta.url))

function classifyFailure(message, thread) {
  if (thread && message.includes(`thread ${thread} already has an active writer`)) return 'thread-busy'
  if (message.includes('Not inside a trusted directory and --skip-git-repo-check was not specified')) return 'workspace-untrusted'
  if (/\b(?:unexpected status 401|401 Unauthorized)\b/i.test(message)) return 'authorization'
  if (/\b(?:unexpected status 429|429 Too Many Requests|rate limit reached)\b/i.test(message)) return 'rate-limit'
}

export async function runCodex(codexPath, prompt, previousThread, {
  projectDir = project, model, effort, serviceTier, signal,
} = {}) {
  if (signal?.aborted) return { thread: previousThread, ok: false, failure: 'cancelled' }

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
  let failure
  let threadBusy = false
  const finished = once(child, 'close').catch(() => {
    failure = 'codex-start'
    return [null]
  })
  let interrupted = false
  let forceStop
  const interrupt = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    interrupted = child.kill('SIGINT')
    if (interrupted) forceStop = setTimeout(() => child.kill('SIGKILL'), 5_000)
  }
  signal?.addEventListener('abort', interrupt, { once: true })
  function recordDiagnostic(message) {
    if (typeof message !== 'string') return
    const type = classifyFailure(message, previousThread)
    if (type === 'thread-busy') threadBusy = true
    else if (type) failure = type
  }
  const diagnostics = createInterface({ input: child.stderr })
  diagnostics.on('line', recordDiagnostic)
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

  let thread = previousThread
  let completed = false
  const lines = createInterface({ input: child.stdout })
  for await (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'thread.started' && /^[0-9a-f-]{36}$/i.test(event.thread_id)) thread = event.thread_id
    if (event.type === 'error') recordDiagnostic(event.message)
    if (event.type === 'turn.failed') recordDiagnostic(event.error?.message)
    if (event.type === 'turn.completed') completed = true
  }
  const [code] = await finished
  clearTimeout(forceStop)
  signal?.removeEventListener('abort', interrupt)
  const ok = code === 0 && completed
  if (ok) return { thread, ok }
  if (threadBusy) return { thread, ok, failure: 'thread-busy' }
  if (interrupted) return { thread, ok, failure: 'cancelled' }
  return { thread, ok, failure: failure ?? 'codex-failed' }
}

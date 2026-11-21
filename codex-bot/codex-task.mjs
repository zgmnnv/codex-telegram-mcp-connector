import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../../', import.meta.url))

export async function runCodex(codexPath, prompt, previousThread, { projectDir = project, model, effort, serviceTier } = {}) {
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

  const child = spawn(codexPath, args, { cwd: projectDir, stdio: ['pipe', 'pipe', 'ignore'] })
  const finished = once(child, 'close').catch(() => [null])
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
  return { thread, ok: code === 0 && completed, text }
}

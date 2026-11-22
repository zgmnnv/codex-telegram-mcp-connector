import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const sources = ['appServer', 'vscode', 'cli', 'exec']
const newChatsSectionName = 'Новые чаты'
export const taskSandbox = 'read-only'

async function withServer(codexPath, cwd, operation) {
  const child = spawn(codexPath, ['app-server'], {
    cwd, stdio: ['pipe', 'pipe', 'ignore'], signal: AbortSignal.timeout(30_000),
  })
  child.on('error', () => {})
  child.stdin.on('error', () => {})
  const messages = createInterface({ input: child.stdout })
  const replies = messages[Symbol.asyncIterator]()
  let id = 0
  const send = request => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n')
  async function request(method, params) {
    const requestId = ++id
    send({ id: requestId, method, params })
    for (;;) {
      const { value, done } = await replies.next()
      if (done) throw new Error('Codex завершил соединение.')
      const reply = JSON.parse(value)
      if (reply.id !== requestId) continue
      if (reply.error) {
        const error = new Error(`Codex отклонил ${method}.`)
        error.code = reply.error.code
        error.unsupported = /unknown variant|method not found/i.test(reply.error.message)
        throw error
      }
      return reply.result
    }
  }
  try {
    await request('initialize', {
      clientInfo: { name: 'telegram_codex', version: '1' },
      capabilities: { experimentalApi: true },
    })
    send({ method: 'initialized' })
    return await operation(request)
  } finally {
    messages.close()
    child.stdin.end()
    child.kill()
  }
}

// Older desktop memberships may still live in the sidebar state.
function desktopMemberships(home = join(homedir(), '.codex')) {
  let state
  try {
    state = JSON.parse(readFileSync(join(home, '.codex-global-state.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return new Map()
  }
  const byHost = state['app-server-project-id-by-legacy-project-id-by-host'] || {}
  const projectIds = byHost[`local:${home}`] || {}
  const assignments = state['thread-project-assignments'] || {}
  const hosts = state['thread-project-membership-host-ids'] || {}
  const local = Object.entries(assignments).filter(([id, entry]) => {
    return entry?.projectKind === 'local' && (!hosts[id] || hosts[id] === 'local')
  })
  return new Map(local.map(([id, entry]) => [id, projectIds[entry.projectId] ?? entry.projectId]))
}

async function allPages(request, method, params) {
  const data = []
  let cursor
  do {
    const page = await request(method, { ...params, limit: 100, cursor })
    data.push(...page.data)
    cursor = page.nextCursor
  } while (cursor)
  return data
}

async function findNewChatsSection(request) {
  try {
    const sections = await allPages(request, 'threadSection/list', {})
    return sections.find(section => section.name === newChatsSectionName)
  } catch (error) {
    if (error.code === -32601 || error.unsupported) return undefined
    throw error
  }
}

export function createCatalog(codexPath, defaultWorkspace) {
  const execute = operation => withServer(codexPath, defaultWorkspace, operation)
  const query = (method, params) => execute(request => request(method, params))
  const listThreads = (request, projectId, sectionId) => allPages(request, 'thread/list', {
    projectId, sectionId, archived: false, sourceKinds: sources, currentAccountOnly: true, useStateDbOnly: true,
    sortKey: 'updated_at',
  })

  async function listProjectThreads(request, projectId, section) {
    const threads = await listThreads(request, projectId)
    if (!section) return threads

    // Codex's regular listing omits threads with no preview, even when named.
    const sectionThreads = await listThreads(request, projectId, section.id)
    return [...new Map([...threads, ...sectionThreads].map(thread => [thread.id, thread])).values()]
  }

  async function activeChats(projectId) {
    const memberships = desktopMemberships()
    return execute(async request => {
      const section = await findNewChatsSection(request)
      const native = await listProjectThreads(request, projectId, section)
      const threads = projectId === null
        ? native.filter(thread => thread.projectId == null && !memberships.has(thread.id))
        : native.filter(thread => thread.projectId === projectId)
      if (projectId !== null && [...memberships.values()].includes(projectId)) {
        const legacy = await listProjectThreads(request, null, section)
        threads.push(...legacy.filter(thread => thread.projectId == null && memberships.get(thread.id) === projectId))
      }
      return threads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    })
  }

  return {
    async projects() {
      return execute(request => allPages(request, 'project/list', { sortKey: 'position' }))
    },
    async chats(projectId) {
      return (await activeChats(projectId)).map(thread => ({
        thread: thread.id,
        title: thread.name || 'Чат без названия',
        projectId,
      }))
    },
    async models(cursor) {
      return query('model/list', { includeHidden: false, limit: 8, cursor })
    },
    async modelOptions() {
      return execute(request => allPages(request, 'model/list', { includeHidden: false }))
    },
    async createProject(name, requestId = randomUUID()) {
      const { project } = await query('project/create', { name, roots: [], idempotencyKey: requestId })
      return project
    },
    async createChat(project, title) {
      return execute(async request => {
        const projectId = project?.id ?? null
        const cwd = project?.roots[0]?.path || defaultWorkspace
        const section = await findNewChatsSection(request)
          ?? (await request('threadSection/create', { name: newChatsSectionName })).section
        const { thread } = await request('thread/start', {
          cwd, projectId, historyMode: 'paginated', ephemeral: false, approvalPolicy: 'never', sandbox: taskSandbox,
          config: { mcp_servers: {}, features: { apps: false } },
        })
        try {
          await request('thread/name/set', { threadId: thread.id, name: title })
          await request('thread/section/move', { threadId: thread.id, sectionId: section.id })
        } catch (error) {
          await request('thread/archive', { threadId: thread.id }).catch(() => {})
          throw error
        }
        return { thread: thread.id, projectId, title }
      })
    },
    async resumePath(context) {
      const thread = (await activeChats(context.projectId)).find(row => row.id === context.thread)
      if (!thread || thread.status?.type === 'active') return null
      const { data } = await query('thread/turns/list', {
        threadId: context.thread, itemsView: 'notLoaded', limit: 1, sortDirection: 'desc',
      })
      return data[0]?.status === 'inProgress' ? null : thread.cwd
    },
  }
}

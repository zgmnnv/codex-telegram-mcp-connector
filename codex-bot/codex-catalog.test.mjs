import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCatalog } from './codex-catalog.mjs'

test('named empty chats stay in their project and can receive a first task', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-catalog-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const cli = join(directory, 'codex')
  const stateFile = join(directory, 'state.json')
  await writeFile(stateFile, JSON.stringify({ sections: [], threads: [] }))
  await writeFile(cli, `#!/usr/bin/env node
const assert = require('node:assert/strict')
const fs = require('node:fs')
const readline = require('node:readline')
const file = ${JSON.stringify(stateFile)}
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const save = () => fs.writeFileSync(file, JSON.stringify(state))

function reply(method, params) {
  const thread = state.threads.find(item => item.id === params?.threadId)
  switch (method) {
    case 'initialize':
      return {}
    case 'threadSection/list':
      return { data: state.sections }
    case 'threadSection/create': {
      const section = { id: 'section-a', name: params.name }
      state.sections.push(section)
      save()
      return { section }
    }
    case 'thread/start': {
      assert.equal(params.ephemeral, false)
      const current = {
        id: 'sample-' + state.threads.length, cwd: params.cwd, projectId: params.projectId,
        preview: '', sectionId: null, updatedAt: state.threads.length,
      }
      state.threads.push(current)
      save()
      return { thread: current }
    }
    case 'thread/name/set':
      thread.name = params.name
      save()
      return {}
    case 'thread/section/move':
      thread.sectionId = params.sectionId
      save()
      return {}
    case 'thread/list':
      assert.equal(params.archived, false)
      assert.equal(params.currentAccountOnly, true)
      return { data: state.threads.filter(item =>
        item.projectId === params.projectId && !item.archived && !item.otherAccount
        && (params.sectionId ? item.sectionId === params.sectionId : item.preview),
      ) }
    case 'thread/turns/list':
      assert.ok(thread)
      return { data: [] }
    default:
      throw new Error(method)
  }
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line)
  if (id) console.log(JSON.stringify({ id, result: reply(method, params) }))
})
`, { mode: 0o700 })

  const project = { id: 'project-a', roots: [] }
  const catalog = createCatalog(cli, directory)
  const created = await catalog.createChat(project, 'Sample empty chat')
  const standalone = await catalog.createChat(null, 'Sample standalone chat')
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.deepEqual(state.sections, [{ id: 'section-a', name: 'Новые чаты' }])
  assert.deepEqual(state.threads.map(thread => thread.sectionId), ['section-a', 'section-a'])
  assert.deepEqual(state.threads.map(thread => thread.preview), ['', ''])

  const restored = createCatalog(cli, directory)
  assert.deepEqual(await restored.chats(project.id), [created])
  assert.deepEqual(await restored.chats(null), [standalone])
  assert.deepEqual(await restored.chats('project-b'), [])
  assert.equal(await restored.resumePath(created), directory)
  assert.equal(await restored.resumePath({ ...created, projectId: 'project-b' }), null)

  state.threads[0].preview = 'First example message'
  state.threads.push(
    { ...state.threads[0], id: 'archived', archived: true },
    { ...state.threads[0], id: 'other-account', otherAccount: true },
  )
  await writeFile(stateFile, JSON.stringify(state))
  assert.deepEqual(await restored.chats(project.id), [created])
})

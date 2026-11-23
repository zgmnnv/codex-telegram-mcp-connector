import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const pauseMs = 120_000
const threadId = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

export async function startSharedServer(codexPath, cwd, privateDirectory) {
  const { stdout } = await exec(codexPath, ['--version'], { timeout: 5_000 })
  const version = stdout.match(/^codex-cli 0\.(\d+)\.\d+\s*$/)
  if (!version || Number(version[1]) < 171) {
    throw new Error('Для общего App Server нужен стабильный Codex CLI 0.171 или новее.')
  }

  // Keep the Unix path short and accessible only to this macOS user.
  const directory = mkdtempSync('/private/tmp/codex-tg-')
  const socket = join(directory, 'app.sock')
  const locks = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'thread-writer-locks')
  const stateFile = join(privateDirectory, 'shared-server.json')
  let server
  let draining = false
  let closing = false
  let closePromise
  let pausedThread
  let resumeTimer

  async function start() {
    // This socket belongs to one supervisor instance and its previous child has exited.
    rmSync(socket, { force: true })
    const child = spawn(codexPath, ['app-server', '--listen', `unix://${socket}`], {
      cwd, stdio: 'ignore', detached: true,
    })
    const closed = once(child, 'close').then(([code]) => code, () => null)
    let stopRequested = false
    const stop = () => {
      if (stopRequested || child.exitCode !== null || child.signalCode !== null) return false
      stopRequested = true
      return child.kill('SIGHUP')
    }
    server = { child, closed, stop }
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) break
      try {
        if (statSync(socket).isSocket()) return
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await sleep(100)
    }
    stop()
    throw new Error('Общий App Server не запустился.')
  }

  try {
    await start()
    mkdirSync(privateDirectory, { mode: 0o700, recursive: true })
    const temporary = join(privateDirectory, `shared-server-${process.pid}.tmp`)
    writeFileSync(temporary, JSON.stringify({ socket }) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, stateFile)
  } catch (error) {
    if (server) {
      server.stop()
      await server.closed
    }
    rmSync(directory, { recursive: true, force: true })
    throw error
  }

  async function restart() {
    clearTimeout(resumeTimer)
    pausedThread = undefined
    if (closing) return
    try {
      await start()
    } catch {
      console.error('Не удалось снова подключить общий App Server.')
    }
  }

  async function holds(thread) {
    const child = server.child
    if (closing || draining || pausedThread || !threadId.test(thread) || child.exitCode !== null || child.signalCode !== null) return false
    try {
      const lock = join(locks, `${thread}.lock`)
      const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(child.pid), '-Fn', lock], { timeout: 5_000 })
      return server.child === child && stdout.split('\n').includes(`n${lock}`)
    } catch {
      return false
    }
  }

  return {
    holds,
    async release(thread) {
      if (!await holds(thread) || closing || draining || pausedThread) return false
      draining = true
      try {
        // On the Unix transport SIGHUP requests graceful shutdown without force escalation.
        if (!server.stop() || await server.closed !== 0) throw new Error('Общий App Server не подтвердил завершение.')
        pausedThread = thread
        if (!closing) {
          resumeTimer = setTimeout(() => void restart(), pauseMs)
          resumeTimer.unref()
        }
        return true
      } finally {
        draining = false
      }
    },
    async run(thread, task) {
      if (pausedThread !== thread) return task()
      clearTimeout(resumeTimer)
      try {
        return await task()
      } finally {
        await restart()
      }
    },
    close() {
      if (closePromise) return closePromise
      closing = true
      clearTimeout(resumeTimer)
      server.stop()
      closePromise = server.closed.then(() => {
        try {
          const state = JSON.parse(readFileSync(stateFile, 'utf8'))
          if (state.socket === socket) rmSync(stateFile)
        } catch {}
        rmSync(directory, { recursive: true, force: true })
      })
      return closePromise
    },
  }
}

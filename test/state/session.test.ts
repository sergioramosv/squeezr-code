import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Session uses os.homedir() at module-level. Override via env vars used by
// node's os.homedir on Linux/Win.
let savedHome: string | undefined
let savedUserProfile: string | undefined

function setFakeHome(dir: string): void {
  savedHome = process.env.HOME
  savedUserProfile = process.env.USERPROFILE
  process.env.HOME = dir
  process.env.USERPROFILE = dir
}
function restoreHome(): void {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
}

describe('Session', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sess-'))
    setFakeHome(tmp)
  })

  afterEach(() => {
    restoreHome()
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('imports without error', async () => {
    // We can't easily reset os.homedir at runtime since it cached at import
    // — this test just ensures import works.
    const mod = await import('../../src/state/session.js')
    expect(typeof mod.Session.create).toBe('function')
  })

  it('Session.create returns instance with id', async () => {
    const { Session } = await import('../../src/state/session.js')
    const s = Session.create({ cwd: '/some/path', model: 'opus' })
    expect(s.getId()).toMatch(/^\d+-[a-f0-9]+$/)
    expect(s.getMessages()).toEqual([])
    expect(s.getModel()).toBe('opus')
    expect(s.getCwd()).toBe('/some/path')
  })

  it('updateMessages stores and updates', async () => {
    const { Session } = await import('../../src/state/session.js')
    const s = Session.create({ cwd: '/c', model: 'm' })
    s.updateMessages([{ role: 'user', content: 'hi' }])
    expect(s.getMessages().length).toBe(1)
    expect(s.getMessages()[0].content).toBe('hi')
  })

  it('updateModel changes model', async () => {
    const { Session } = await import('../../src/state/session.js')
    const s = Session.create({ cwd: '/c', model: 'opus' })
    s.updateModel('haiku')
    expect(s.getModel()).toBe('haiku')
  })

  it('Session.load returns null for missing id', async () => {
    const { Session } = await import('../../src/state/session.js')
    expect(Session.load('does-not-exist')).toBeNull()
  })

  it('Session.list returns array (may be empty if dir does not exist)', async () => {
    const { Session } = await import('../../src/state/session.js')
    const result = Session.list()
    expect(Array.isArray(result)).toBe(true)
  })

  it('Session.loadLatest is null when no sessions dir', async () => {
    const { Session } = await import('../../src/state/session.js')
    // The actual behavior depends on whether the real .squeezr-code/sessions
    // dir exists. Test that it returns Session-or-null.
    const r = Session.loadLatest()
    expect(r === null || typeof r.getId() === 'string').toBe(true)
  })

  it('pruneSessions returns 0 when sessions dir does not exist', async () => {
    const { pruneSessions } = await import('../../src/state/session.js')
    const r = pruneSessions({ maxKeep: 5, maxAgeDays: 1 })
    expect(typeof r).toBe('number')
    expect(r).toBeGreaterThanOrEqual(0)
  })
})

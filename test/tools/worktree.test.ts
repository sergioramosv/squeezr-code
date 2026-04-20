import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { enterWorktree, exitWorktree, getActiveWorktree, setWorktreeCwdChanger } from '../../src/tools/worktree.js'

describe('worktree', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-wt-'))
    setWorktreeCwdChanger(null)
    // ensure no leftover state
    try { exitWorktree({ action: 'remove', discard_changes: true }) } catch { /* ignore */ }
  })

  afterEach(() => {
    try { exitWorktree({ action: 'remove', discard_changes: true }) } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns error string for tmp dir (no git repo or worktree exists)', () => {
    const out = enterWorktree({ name: 'test-' + Date.now().toString(36), cwd: tmp })
    expect(out).toMatch(/no git repo|Error creating worktree|already exists|Already inside/i)
  })

  it('rejects invalid name characters', () => {
    // For the name validation, we still need to reach the sanitize check -
    // we need a real git repo. Using the project root works.
    const out = enterWorktree({ name: 'bad name!', cwd: process.cwd() })
    expect(out).toMatch(/invalid name|already exists|no git repo|already inside/i)
  })

  it('rejects passing both name and path', () => {
    const out = enterWorktree({ name: 'a', path: '/p', cwd: process.cwd() })
    expect(out).toContain('Pass `name` or `path`')
  })

  it('errors when entering non-registered worktree path', () => {
    const out = enterWorktree({ path: '/nonexistent/path', cwd: process.cwd() })
    expect(out).toMatch(/not a registered worktree|no git repo/i)
  })

  it('exitWorktree with no active is safe', () => {
    const out = exitWorktree({ action: 'keep' })
    expect(out).toContain('No active worktree')
  })

  it('getActiveWorktree returns null when nothing active', () => {
    expect(getActiveWorktree()).toBeNull()
  })

  it('setWorktreeCwdChanger accepts null', () => {
    expect(() => setWorktreeCwdChanger(null)).not.toThrow()
  })

  it('setWorktreeCwdChanger accepts function', () => {
    expect(() => setWorktreeCwdChanger(() => {})).not.toThrow()
  })
})

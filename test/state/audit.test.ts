import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// We have to import after we set up the homedir mock... but the module reads
// homedir at import time. We use vi.spyOn before calling functions that write.
import { logToolEvent, setAuditEnabled, isAuditEnabled, getAuditPath } from '../../src/state/audit.js'

describe('audit', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-audit-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
    setAuditEnabled(false, '')
  })

  it('isAuditEnabled defaults to false', () => {
    setAuditEnabled(false, '')
    expect(isAuditEnabled()).toBe(false)
  })

  it('setAuditEnabled toggles state', () => {
    setAuditEnabled(true, 'sid1')
    expect(isAuditEnabled()).toBe(true)
    setAuditEnabled(false, '')
    expect(isAuditEnabled()).toBe(false)
  })

  it('returns audit path under home dir', () => {
    expect(getAuditPath()).toContain('.squeezr-code')
    expect(getAuditPath()).toContain('audit.log')
  })

  it('logToolEvent does nothing when disabled', () => {
    setAuditEnabled(false, '')
    const before = fs.existsSync(getAuditPath()) ? fs.statSync(getAuditPath()).size : 0
    logToolEvent({ tool: 'Bash', input: { cmd: 'ls' }, output: 'output here', cwd: '/tmp' })
    const after = fs.existsSync(getAuditPath()) ? fs.statSync(getAuditPath()).size : 0
    expect(after).toBe(before) // no growth
  })

  it('does not throw on fs error (best-effort silently caught)', () => {
    setAuditEnabled(true, 'sid')
    // Hijack fs.appendFileSync to throw
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('disk full') })
    expect(() => logToolEvent({ tool: 'X', input: {}, output: 'y', cwd: '/' })).not.toThrow()
    spy.mockRestore()
  })

  it('writes JSONL line when enabled (writes to real audit path)', () => {
    setAuditEnabled(true, 'session-abc')
    const captured: string[] = []
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation((_p, data: any) => { captured.push(String(data)) })
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any)
    logToolEvent({ tool: 'Bash', input: { cmd: 'echo hi' }, output: 'hi\n', cwd: '/work' })
    expect(captured.length).toBe(1)
    const line = captured[0]
    expect(line.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(line.trim())
    expect(parsed.tool).toBe('Bash')
    expect(parsed.sid).toBe('session-abc')
    expect(parsed.cwd).toBe('/work')
    expect(parsed.input).toEqual({ cmd: 'echo hi' })
    expect(typeof parsed.out_sha256).toBe('string')
    expect(parsed.out_sha256.length).toBe(16)
    expect(parsed.out_preview).toBe('hi\n')
    expect(parsed.error).toBeUndefined()
    spy.mockRestore()
    mkdir.mockRestore()
  })

  it('truncates long output preview to 500 chars + ellipsis', () => {
    setAuditEnabled(true, 'sid')
    const captured: string[] = []
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation((_p, data: any) => { captured.push(String(data)) })
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any)
    const long = 'x'.repeat(2000)
    logToolEvent({ tool: 'Read', input: {}, output: long, cwd: '/' })
    const parsed = JSON.parse(captured[0])
    expect(parsed.out_preview.length).toBe(501) // 500 + "…"
    expect(parsed.out_preview.endsWith('…')).toBe(true)
    spy.mockRestore()
    mkdir.mockRestore()
  })

  it('marks error: true when isError flag passed', () => {
    setAuditEnabled(true, 'sid')
    const captured: string[] = []
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation((_p, data: any) => { captured.push(String(data)) })
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as any)
    logToolEvent({ tool: 'Bash', input: {}, output: 'err', cwd: '/', isError: true })
    expect(JSON.parse(captured[0]).error).toBe(true)
    spy.mockRestore()
    mkdir.mockRestore()
  })
})

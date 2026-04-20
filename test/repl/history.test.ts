import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { loadHistory, appendHistory } from '../../src/repl/history.js'

describe('history', () => {
  it('loadHistory returns array', () => {
    const r = loadHistory()
    expect(Array.isArray(r)).toBe(true)
  })

  it('appendHistory does not throw on empty input', () => {
    expect(() => appendHistory('')).not.toThrow()
    expect(() => appendHistory('   ')).not.toThrow()
  })

  it('appendHistory tolerates fs error', () => {
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('fail') })
    expect(() => appendHistory('test entry ' + Date.now())).not.toThrow()
    spy.mockRestore()
  })

  it('loadHistory tolerates fs error', () => {
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('fail') })
    expect(loadHistory()).toEqual([])
    spy.mockRestore()
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadCustomCommands, expandCustomCommand } from '../../src/repl/custom-commands.js'

describe('loadCustomCommands', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cmds-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns array', () => {
    const r = loadCustomCommands(tmp)
    expect(Array.isArray(r)).toBe(true)
  })

  it('reads .md from project commands dir', () => {
    const cmdDir = path.join(tmp, '.squeezr', 'commands')
    fs.mkdirSync(cmdDir, { recursive: true })
    fs.writeFileSync(path.join(cmdDir, 'review.md'), `---
description: PR Review
---
Please review the diff: $ARGS
`)
    const r = loadCustomCommands(tmp)
    const cmd = r.find(c => c.name === 'review')
    expect(cmd).toBeDefined()
    expect(cmd!.description).toBe('PR Review')
    expect(cmd!.prompt).toContain('$ARGS')
  })

  it('uses first non-empty body line as description when no frontmatter', () => {
    const cmdDir = path.join(tmp, '.squeezr', 'commands')
    fs.mkdirSync(cmdDir, { recursive: true })
    fs.writeFileSync(path.join(cmdDir, 'foo.md'), 'First line is the description\n\nbody')
    const r = loadCustomCommands(tmp)
    const cmd = r.find(c => c.name === 'foo')
    expect(cmd).toBeDefined()
    expect(cmd!.description).toContain('First line')
  })

  it('skips non-md files', () => {
    const cmdDir = path.join(tmp, '.squeezr', 'commands')
    fs.mkdirSync(cmdDir, { recursive: true })
    fs.writeFileSync(path.join(cmdDir, 'foo.txt'), 'not loaded')
    const r = loadCustomCommands(tmp)
    expect(r.find(c => c.name === 'foo')).toBeUndefined()
  })
})

describe('expandCustomCommand', () => {
  it('substitutes $ARGS placeholder', () => {
    const cmd = { name: 'x', description: 'd', prompt: 'do $ARGS now', source: '/' }
    expect(expandCustomCommand(cmd, 'X')).toBe('do X now')
  })

  it('replaces all occurrences of $ARGS', () => {
    const cmd = { name: 'x', description: 'd', prompt: '$ARGS / $ARGS', source: '/' }
    expect(expandCustomCommand(cmd, 'foo')).toBe('foo / foo')
  })

  it('appends args at end when no $ARGS placeholder', () => {
    const cmd = { name: 'x', description: 'd', prompt: 'base prompt', source: '/' }
    expect(expandCustomCommand(cmd, 'extra')).toBe('base prompt\n\nextra')
  })

  it('returns prompt as-is when no $ARGS and empty args', () => {
    const cmd = { name: 'x', description: 'd', prompt: 'base', source: '/' }
    expect(expandCustomCommand(cmd, '')).toBe('base')
  })
})

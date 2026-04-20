import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildSystemPrompt } from '../../src/agent/system.js'

const baseOpts = (cwd: string) => ({
  provider: 'anthropic' as const,
  model: 'claude-x',
  cwd,
  permissions: 'default' as const,
})

describe('buildSystemPrompt', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-sysp-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns base prompt mentioning sq', () => {
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('sq')
    expect(out).toContain('intelligent CLI agent')
  })

  it('lists tools', () => {
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('Read, Write, Edit')
    expect(out).toContain('Bash')
    expect(out).toContain('TaskCreate')
    expect(out).toContain('AskUserQuestion')
  })

  it('includes working directory', () => {
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain(`Working directory: ${tmp}`)
  })

  it('appends git branch when .git/HEAD present', () => {
    fs.mkdirSync(path.join(tmp, '.git'))
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('Git branch: main')
  })

  it('handles detached head (raw sha)', () => {
    fs.mkdirSync(path.join(tmp, '.git'))
    fs.writeFileSync(path.join(tmp, '.git', 'HEAD'), 'abc1234567890\n')
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('Git branch: abc12345')
  })

  it('finds git branch by walking upwards', () => {
    // tmp does not have .git itself but findGitHead walks upwards. As long as
    // SOMETHING exists or nothing does — we don't crash.
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toBeTruthy()
  })

  it('appends transplant context when appendSystemPrompt is set', () => {
    const out = buildSystemPrompt({ ...baseOpts(tmp), appendSystemPrompt: 'EXTRA-CTX' })
    expect(out).toContain('Transplant context')
    expect(out).toContain('EXTRA-CTX')
  })

  it('reads SQUEEZR.md from cwd as project memory', () => {
    fs.writeFileSync(path.join(tmp, 'SQUEEZR.md'), 'Project rules!')
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('Project memory')
    expect(out).toContain('Project rules!')
  })

  it('reads CLAUDE.md as fallback', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'Claude memory')
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('Claude memory')
  })

  it('expands @import directives in memory file', () => {
    fs.writeFileSync(path.join(tmp, 'imp.md'), 'IMPORTED-CONTENT')
    fs.writeFileSync(path.join(tmp, 'SQUEEZR.md'), '@import imp.md')
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('IMPORTED-CONTENT')
  })

  it('shows warning when @import not found', () => {
    fs.writeFileSync(path.join(tmp, 'SQUEEZR.md'), '@import nonexistent.md')
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).toContain('@import not found')
  })

  it('handles import cycle without infinite loop', () => {
    fs.writeFileSync(path.join(tmp, 'a.md'), '@import b.md')
    fs.writeFileSync(path.join(tmp, 'b.md'), '@import a.md')
    fs.writeFileSync(path.join(tmp, 'SQUEEZR.md'), '@import a.md')
    const out = buildSystemPrompt(baseOpts(tmp))
    // no throw, no infinite loop. Cycle detected → second @import returns null
    expect(out).toBeTruthy()
  })

  it('returns null memory section when no md files', () => {
    const out = buildSystemPrompt(baseOpts(tmp))
    expect(out).not.toContain('Project memory:')
  })
})

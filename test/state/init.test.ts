import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runInit } from '../../src/state/init.js'

describe('runInit', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-init-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('creates sq.toml and SQUEEZR.md from scratch', () => {
    const r = runInit(tmp)
    expect(r.created).toContain('sq.toml')
    expect(r.created).toContain('SQUEEZR.md')
    expect(fs.existsSync(path.join(tmp, 'sq.toml'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'SQUEEZR.md'))).toBe(true)
  })

  it('skips existing files', () => {
    fs.writeFileSync(path.join(tmp, 'sq.toml'), 'existing')
    const r = runInit(tmp)
    expect(r.skipped).toContain('sq.toml')
    expect(r.created).not.toContain('sq.toml')
    expect(fs.readFileSync(path.join(tmp, 'sq.toml'), 'utf-8')).toBe('existing')
  })

  it('detects Node project from package.json', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'pkg',
      description: 'A test package',
      scripts: { build: 'tsc', test: 'vitest', dev: 'tsc -w' },
      dependencies: { react: '^18' },
    }))
    runInit(tmp)
    const md = fs.readFileSync(path.join(tmp, 'SQUEEZR.md'), 'utf-8')
    expect(md).toContain('A test package')
    expect(md).toContain('JavaScript')
    expect(md).toContain('React')
    expect(md).toContain('npm run build')
  })

  it('detects TypeScript when tsconfig present', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'p', scripts: { build: 'tsc' },
    }))
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}')
    runInit(tmp)
    expect(fs.readFileSync(path.join(tmp, 'SQUEEZR.md'), 'utf-8')).toContain('TypeScript')
  })

  it('detects pnpm when pnpm-lock.yaml present', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'p', scripts: { build: 'tsc' },
    }))
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), '')
    runInit(tmp)
    expect(fs.readFileSync(path.join(tmp, 'SQUEEZR.md'), 'utf-8')).toContain('pnpm')
  })

  it('detects Python (pyproject.toml)', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]')
    runInit(tmp)
    expect(fs.readFileSync(path.join(tmp, 'SQUEEZR.md'), 'utf-8')).toContain('Python')
  })

  it('detects Rust (Cargo.toml)', () => {
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]')
    runInit(tmp)
    const md = fs.readFileSync(path.join(tmp, 'SQUEEZR.md'), 'utf-8')
    expect(md).toContain('Rust')
    expect(md).toContain('cargo build')
  })

  it('detects Go (go.mod)', () => {
    fs.writeFileSync(path.join(tmp, 'go.mod'), 'module foo')
    runInit(tmp)
    const md = fs.readFileSync(path.join(tmp, 'SQUEEZR.md'), 'utf-8')
    expect(md).toContain('Go')
    expect(md).toContain('go build')
  })

  it('lists top-level dirs in structure', () => {
    fs.mkdirSync(path.join(tmp, 'src'))
    fs.mkdirSync(path.join(tmp, 'tests'))
    runInit(tmp)
    const md = fs.readFileSync(path.join(tmp, 'SQUEEZR.md'), 'utf-8')
    expect(md).toContain('src/')
    expect(md).toContain('tests/')
  })

  it('handles malformed package.json gracefully', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), 'invalid json')
    expect(() => runInit(tmp)).not.toThrow()
  })
})

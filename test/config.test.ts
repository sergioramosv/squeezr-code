import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  let tmp: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cfg-'))
    savedEnv = {
      SQ_MODEL: process.env.SQ_MODEL,
      SQ_PROXY_PORT: process.env.SQ_PROXY_PORT,
      SQ_PERMISSIONS: process.env.SQ_PERMISSIONS,
      SQ_MCP_AUTO_IMPORT: process.env.SQ_MCP_AUTO_IMPORT,
    }
    delete process.env.SQ_MODEL
    delete process.env.SQ_PROXY_PORT
    delete process.env.SQ_PERMISSIONS
    delete process.env.SQ_MCP_AUTO_IMPORT
  })

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('returns defaults when no toml exists', () => {
    const cfg = loadConfig(tmp)
    expect(cfg.agent).toBeDefined()
    expect(cfg.agent.default).toBeTruthy()
    expect(cfg.permissions).toBeDefined()
    expect(cfg.transplant).toBeDefined()
    expect(cfg.economist).toBeDefined()
    expect(cfg.display).toBeDefined()
    expect(cfg.audit.enabled).toBe(false)
  })

  it('merges sq.toml from project dir', () => {
    fs.writeFileSync(path.join(tmp, 'sq.toml'), `
[agent]
default = "haiku"
permissions = "bypass"
`)
    const cfg = loadConfig(tmp)
    expect(cfg.agent.default).toBe('haiku')
    expect(cfg.agent.permissions).toBe('bypass')
  })

  it('SQ_MODEL env override wins', () => {
    process.env.SQ_MODEL = 'env-model'
    const cfg = loadConfig(tmp)
    expect(cfg.agent.default).toBe('env-model')
  })

  it('SQ_PERMISSIONS env override wins', () => {
    process.env.SQ_PERMISSIONS = 'plan'
    const cfg = loadConfig(tmp)
    expect(cfg.agent.permissions).toBe('plan')
  })

  it('SQ_PROXY_PORT env override wins', () => {
    process.env.SQ_PROXY_PORT = '4242'
    const cfg = loadConfig(tmp)
    expect(cfg.proxy.port).toBe(4242)
  })

  it('SQ_MCP_AUTO_IMPORT=1 enables', () => {
    process.env.SQ_MCP_AUTO_IMPORT = '1'
    expect(loadConfig(tmp).mcp_auto_import).toBe(true)
  })

  it('SQ_MCP_AUTO_IMPORT=0 disables', () => {
    process.env.SQ_MCP_AUTO_IMPORT = '0'
    expect(loadConfig(tmp).mcp_auto_import).toBe(false)
  })

  it('SQ_MCP_AUTO_IMPORT=false disables', () => {
    process.env.SQ_MCP_AUTO_IMPORT = 'false'
    expect(loadConfig(tmp).mcp_auto_import).toBe(false)
  })

  it('reads [mcp_import] enabled = true', () => {
    fs.writeFileSync(path.join(tmp, 'sq.toml'), `
[mcp_import]
enabled = true
`)
    expect(loadConfig(tmp).mcp_auto_import).toBe(true)
  })

  it('handles malformed toml gracefully (returns defaults)', () => {
    fs.writeFileSync(path.join(tmp, 'sq.toml'), 'this is not valid toml\n@@@@')
    const cfg = loadConfig(tmp)
    expect(cfg.agent.default).toBeTruthy()
  })

  it('deep-merges nested objects', () => {
    fs.writeFileSync(path.join(tmp, 'sq.toml'), `
[economist]
daily_budget = 999.5
`)
    const cfg = loadConfig(tmp)
    expect(cfg.economist.daily_budget).toBe(999.5)
    // other defaults preserved
    expect(cfg.economist.warn_at).toBeDefined()
  })

  it('reads permission rules', () => {
    fs.writeFileSync(path.join(tmp, 'sq.toml'), `
[permissions]
allow = ["Read", "Bash:git *"]
deny = ["Bash:rm -rf *"]
`)
    const cfg = loadConfig(tmp)
    expect(cfg.permissions.allow).toContain('Read')
    expect(cfg.permissions.deny).toContain('Bash:rm -rf *')
  })
})

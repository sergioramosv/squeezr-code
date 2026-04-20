import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { discoverMcpServers } from '../../src/mcp/discover.js'

describe('discoverMcpServers', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-disc-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns array (possibly empty)', () => {
    const r = discoverMcpServers(tmp)
    expect(Array.isArray(r)).toBe(true)
  })

  it('reads .mcp.json from cwd', () => {
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({
      mcpServers: {
        myserver: { command: 'node', args: ['server.js'], env: { K: 'V' } },
      },
    }))
    const r = discoverMcpServers(tmp)
    const my = r.find(s => s.name.startsWith('myserver'))
    expect(my).toBeDefined()
    expect(my!.command).toBe('node')
    expect(my!.args).toEqual(['server.js'])
    expect(my!.source).toBe('project')
  })

  it('skips entries without command', () => {
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({
      mcpServers: { broken: { args: ['x'] } },
    }))
    const r = discoverMcpServers(tmp)
    expect(r.find(s => s.name === 'broken')).toBeUndefined()
  })

  it('handles malformed JSON gracefully', () => {
    fs.writeFileSync(path.join(tmp, '.mcp.json'), 'not valid json')
    const r = discoverMcpServers(tmp)
    expect(Array.isArray(r)).toBe(true)
  })

  it('handles empty mcpServers object', () => {
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    const r = discoverMcpServers(tmp)
    // Should not throw, the array may have entries from claude code/desktop on dev machine.
    expect(Array.isArray(r)).toBe(true)
  })
})

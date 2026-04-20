import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const BIN = path.resolve(process.cwd(), 'bin', 'sq.js')

function runSq(args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync('node', [BIN, ...args], {
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, out, err: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? -1, out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}

describe('sq CLI smoke', () => {
  it('--version prints semver and exits 0', () => {
    const { code, out } = runSq(['--version'])
    expect(code).toBe(0)
    expect(out).toMatch(/\d+\.\d+\.\d+/)
  }, 30_000)

  it('--help prints command list', () => {
    const r = runSq(['--help'])
    // exit may be 0 or non-zero depending on impl
    const all = r.out + r.err
    expect(all.toLowerCase()).toMatch(/usage|help|sq |squeezr|command/)
  }, 30_000)
})

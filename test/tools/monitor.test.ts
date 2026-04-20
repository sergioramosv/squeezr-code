import { describe, it, expect } from 'vitest'
import { runMonitor } from '../../src/tools/monitor.js'
import os from 'node:os'

describe('runMonitor', () => {
  it('errors when command missing', async () => {
    const out = await runMonitor({ command: '' }, os.tmpdir())
    expect(out).toContain('Error')
  })

  it('runs an echo command and reports exit', async () => {
    const cmd = process.platform === 'win32' ? 'echo hello' : 'echo hello'
    const out = await runMonitor({ command: cmd, timeout_ms: 5000 }, os.tmpdir())
    expect(out).toContain('Monitor')
    expect(out).toContain('exit 0')
    expect(out.toLowerCase()).toContain('hello')
  }, 10_000)

  it('applies filter regex', async () => {
    const cmd = process.platform === 'win32'
      ? 'echo hello && echo error: bad && echo done'
      : 'echo hello; echo "error: bad"; echo done'
    const out = await runMonitor({ command: cmd, filter: 'error', timeout_ms: 5000 }, os.tmpdir())
    expect(out).toContain('error')
    expect(out).not.toContain('hello\n')
  }, 10_000)

  it('handles non-existent command (exit non-zero)', async () => {
    const out = await runMonitor({ command: 'this_command_does_not_exist_xyz', timeout_ms: 5000 }, os.tmpdir())
    expect(out).toContain('Monitor')
    expect(out).toMatch(/exit (?!0)/)
  }, 10_000)

  it('uses description when provided', async () => {
    const out = await runMonitor({ command: 'echo x', description: 'test job', timeout_ms: 3000 }, os.tmpdir())
    expect(out).toContain('test job')
  }, 8_000)
})

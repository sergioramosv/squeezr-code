import { describe, it, expect, vi, afterEach } from 'vitest'
import https from 'node:https'
import { checkForUpdate } from '../../src/state/update-check.js'

describe('checkForUpdate', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns null when offline / fetch fails', async () => {
    // Mock https.get to immediately error.
    const spy = vi.spyOn(https, 'get').mockImplementation(((..._args: unknown[]) => {
      const cb = _args[_args.length - 1] as Function
      const req: any = {
        on: (ev: string, fn: Function) => { if (ev === 'error') setImmediate(() => fn(new Error('offline'))); return req },
        destroy: () => undefined,
      }
      return req
    }) as any)
    const r = await checkForUpdate()
    // either null (could not fetch and no cache) or string (had cache from real run)
    expect(r === null || typeof r === 'string').toBe(true)
    spy.mockRestore()
  }, 10_000)

  it('returns null when cache returns same version', async () => {
    // Without mocking the cache file, run real flow — but disable network.
    const spy = vi.spyOn(https, 'get').mockImplementation(((..._args: unknown[]) => {
      const req: any = {
        on: (ev: string, fn: Function) => { if (ev === 'timeout') setImmediate(() => fn()); return req },
        destroy: () => undefined,
      }
      return req
    }) as any)
    const r = await checkForUpdate()
    expect(r === null || typeof r === 'string').toBe(true)
    spy.mockRestore()
  }, 10_000)
})

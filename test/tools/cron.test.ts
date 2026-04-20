import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cronCreate, cronList, cronDelete, setCronFireHandler, startCronTicker, stopCronTicker } from '../../src/tools/cron.js'

describe('cron', () => {
  beforeEach(() => {
    // wipe state by deleting all jobs
    for (const j of cronList()) cronDelete(j.id)
  })

  afterEach(() => {
    stopCronTicker()
    setCronFireHandler(null)
  })

  describe('cronCreate validation', () => {
    it('rejects invalid cron (wrong field count)', () => {
      expect(() => cronCreate({ cron: '* * *', prompt: 'p' })).toThrow()
    })

    it('accepts 5-field cron', () => {
      const r = cronCreate({ cron: '* * * * *', prompt: 'p' })
      expect(r.id).toBeTruthy()
      expect(r.nextFireAt).toBeGreaterThan(Date.now())
    })

    it('accepts */N step', () => {
      const r = cronCreate({ cron: '*/5 * * * *', prompt: 'p' })
      expect(r.id).toBeTruthy()
    })

    it('accepts N-M range', () => {
      const r = cronCreate({ cron: '0 9-17 * * *', prompt: 'p' })
      expect(r.id).toBeTruthy()
    })

    it('accepts N,M,L list', () => {
      const r = cronCreate({ cron: '0 9,12,18 * * *', prompt: 'p' })
      expect(r.id).toBeTruthy()
    })

    it('accepts exact value', () => {
      const r = cronCreate({ cron: '30 14 * * *', prompt: 'p' })
      expect(r.id).toBeTruthy()
    })
  })

  describe('cronList + cronDelete', () => {
    it('starts empty', () => {
      expect(cronList()).toEqual([])
    })

    it('lists created jobs sorted by nextFireAt', () => {
      cronCreate({ cron: '0 0 * * *', prompt: 'midnight' })
      cronCreate({ cron: '* * * * *', prompt: 'every minute' })
      const list = cronList()
      expect(list.length).toBe(2)
      expect(list[0].nextFireAt).toBeLessThanOrEqual(list[1].nextFireAt)
    })

    it('cronDelete returns true if job existed', () => {
      const { id } = cronCreate({ cron: '* * * * *', prompt: 'p' })
      expect(cronDelete(id)).toBe(true)
      expect(cronList().find(j => j.id === id)).toBeUndefined()
    })

    it('cronDelete returns false if job did not exist', () => {
      expect(cronDelete('cron-nope')).toBe(false)
    })
  })

  describe('expiry', () => {
    it('recurring job has 7-day expiry', () => {
      const r = cronCreate({ cron: '* * * * *', prompt: 'p', recurring: true })
      const job = cronList().find(j => j.id === r.id)!
      const sevenDays = 7 * 24 * 60 * 60 * 1000
      // tolerance: 1 second
      expect(Math.abs(job.expiresAt - (Date.now() + sevenDays))).toBeLessThan(2000)
    })

    it('one-shot job has long expiry (~1 year)', () => {
      const r = cronCreate({ cron: '* * * * *', prompt: 'p', recurring: false })
      const job = cronList().find(j => j.id === r.id)!
      const oneYear = 365 * 24 * 60 * 60 * 1000
      expect(job.expiresAt - Date.now()).toBeGreaterThan(oneYear - 5000)
    })
  })

  describe('fire handler', () => {
    it('setCronFireHandler accepts and clears handler', () => {
      setCronFireHandler(() => {})
      setCronFireHandler(null)
      // No throw = pass
    })
  })

  describe('ticker', () => {
    it('startCronTicker is idempotent', () => {
      startCronTicker()
      startCronTicker() // no error
      stopCronTicker()
    })

    it('stopCronTicker is safe to call without start', () => {
      expect(() => stopCronTicker()).not.toThrow()
    })
  })
})

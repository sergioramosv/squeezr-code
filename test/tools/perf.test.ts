import { describe, it, expect, beforeEach } from 'vitest'
import { trackToolCall, getToolStats, resetToolStats } from '../../src/tools/perf.js'

describe('perf tracker', () => {
  beforeEach(() => resetToolStats())

  it('starts empty', () => {
    expect(getToolStats()).toEqual([])
  })

  it('records single call', () => {
    trackToolCall('Bash', 100, false)
    const stats = getToolStats()
    expect(stats.length).toBe(1)
    expect(stats[0]).toMatchObject({ name: 'Bash', calls: 1, totalMs: 100, maxMs: 100, errors: 0 })
  })

  it('aggregates calls per tool', () => {
    trackToolCall('Bash', 100, false)
    trackToolCall('Bash', 200, false)
    trackToolCall('Read', 50, false)
    const stats = getToolStats()
    expect(stats.length).toBe(2)
    const bash = stats.find(s => s.name === 'Bash')!
    expect(bash.calls).toBe(2)
    expect(bash.totalMs).toBe(300)
    expect(bash.maxMs).toBe(200)
  })

  it('counts errors separately from calls', () => {
    trackToolCall('Bash', 100, false)
    trackToolCall('Bash', 50, true)
    const stats = getToolStats()
    expect(stats[0].errors).toBe(1)
    expect(stats[0].calls).toBe(2)
  })

  it('sorts results by totalMs desc', () => {
    trackToolCall('A', 100, false)
    trackToolCall('B', 500, false)
    trackToolCall('C', 200, false)
    const stats = getToolStats()
    expect(stats.map(s => s.name)).toEqual(['B', 'C', 'A'])
  })

  it('resetToolStats clears state', () => {
    trackToolCall('Bash', 100, false)
    resetToolStats()
    expect(getToolStats()).toEqual([])
  })

  it('maxMs tracks the largest single duration', () => {
    trackToolCall('X', 50, false)
    trackToolCall('X', 500, false)
    trackToolCall('X', 100, false)
    expect(getToolStats()[0].maxMs).toBe(500)
  })
})

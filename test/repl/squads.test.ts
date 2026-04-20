import { describe, it, expect, vi } from 'vitest'
import { parseDispatchBody, applyTemplate, loadSquads, runSquad } from '../../src/repl/squads.js'

describe('parseDispatchBody', () => {
  it('parses single agent line', () => {
    const out = parseDispatchBody('@opus: tell me about TypeScript')
    expect(out).toEqual([{ model: 'opus', prompt: 'tell me about TypeScript' }])
  })

  it('parses multiple agents', () => {
    const out = parseDispatchBody('@opus: A\n@gpt-5: B')
    expect(out.length).toBe(2)
    expect(out[0].model).toBe('opus')
    expect(out[1].model).toBe('gpt-5')
  })

  it('skips empty lines', () => {
    const out = parseDispatchBody('\n@opus: prompt\n\n')
    expect(out.length).toBe(1)
  })

  it('skips lines without @', () => {
    const out = parseDispatchBody('this is a comment\n@opus: hi')
    expect(out.length).toBe(1)
  })

  it('returns empty when no agents', () => {
    expect(parseDispatchBody('just text')).toEqual([])
  })

  it('handles whitespace around colon', () => {
    const out = parseDispatchBody('@opus  :  hello')
    expect(out[0]).toEqual({ model: 'opus', prompt: 'hello' })
  })

  it('skips malformed lines (@x without colon)', () => {
    expect(parseDispatchBody('@opus tell me')).toEqual([])
  })
})

describe('applyTemplate', () => {
  it('replaces {{task}}', () => {
    expect(applyTemplate('do {{task}}', 'thing', [])).toBe('do thing')
  })

  it('replaces {{result_0}}', () => {
    expect(applyTemplate('see {{result_0}}', 't', ['first'])).toBe('see first')
  })

  it('replaces {{result_1}}', () => {
    expect(applyTemplate('{{result_1}}', 't', ['a', 'b'])).toBe('b')
  })

  it('returns empty for missing index', () => {
    expect(applyTemplate('{{result_5}}', 't', ['a'])).toBe('')
  })

  it('replaces {{result_last}}', () => {
    expect(applyTemplate('{{result_last}}', 't', ['a', 'b', 'c'])).toBe('c')
  })

  it('handles empty results for result_last', () => {
    expect(applyTemplate('{{result_last}}', 't', [])).toBe('')
  })

  it('combines task + multiple results', () => {
    const out = applyTemplate('{{task}} -> {{result_0}} + {{result_1}}', 'foo', ['x', 'y'])
    expect(out).toBe('foo -> x + y')
  })

  it('tolerates whitespace inside braces', () => {
    expect(applyTemplate('{{ task }}', 't', [])).toBe('t')
    expect(applyTemplate('{{ result_0 }}', 't', ['x'])).toBe('x')
  })

  it('leaves unknown placeholders alone', () => {
    expect(applyTemplate('{{unknown}}', 't', [])).toBe('{{unknown}}')
  })
})

describe('loadSquads', () => {
  it('returns defaults including opinions, pr-review, build-and-test', () => {
    const squads = loadSquads()
    expect(squads['opinions']).toBeDefined()
    expect(squads['opinions'].mode).toBe('parallel')
    expect(squads['pr-review']).toBeDefined()
    expect(squads['pr-review'].mode).toBe('sequential')
    expect(squads['build-and-test']).toBeDefined()
  })
})

describe('runSquad', () => {
  it('parallel runs all agents and collects results', async () => {
    const squad = {
      mode: 'parallel' as const,
      agents: [
        { model: 'm1', role: 'r1', prompt: '{{task}}' },
        { model: 'm2', role: 'r2', prompt: 'do: {{task}}' },
      ],
    }
    const runAgent = vi.fn(async (model: string, prompt: string, role: string) => `${role}-${model}-${prompt}`)
    const out = await runSquad(squad, 'TASK', runAgent)
    expect(out.length).toBe(2)
    expect(runAgent).toHaveBeenCalledTimes(2)
    expect(out.find(r => r.role === 'r1')!.result).toContain('TASK')
  })

  it('parallel isolates errors (one agent fails, others succeed)', async () => {
    const squad = {
      mode: 'parallel' as const,
      agents: [
        { model: 'good', role: 'a', prompt: 'x' },
        { model: 'bad', role: 'b', prompt: 'x' },
      ],
    }
    const runAgent = vi.fn(async (model: string) => {
      if (model === 'bad') throw new Error('boom')
      return 'ok'
    })
    const out = await runSquad(squad, 'task', runAgent)
    expect(out.length).toBe(2)
    const bad = out.find(r => r.error)
    expect(bad).toBeDefined()
    expect(bad!.result).toContain('boom')
  })

  it('sequential pipes result_N to next agent', async () => {
    const squad = {
      mode: 'sequential' as const,
      agents: [
        { model: 'm1', role: 'r1', prompt: 'first: {{task}}' },
        { model: 'm2', role: 'r2', prompt: 'review of {{result_0}}' },
      ],
    }
    const calls: string[] = []
    const runAgent = vi.fn(async (model: string, prompt: string) => {
      calls.push(prompt)
      return `out-${model}`
    })
    await runSquad(squad, 'TASK', runAgent)
    expect(calls[0]).toBe('first: TASK')
    expect(calls[1]).toBe('review of out-m1')
  })

  it('sequential continues after agent error', async () => {
    const squad = {
      mode: 'sequential' as const,
      agents: [
        { model: 'm1', role: 'a', prompt: 'x' },
        { model: 'm2', role: 'b', prompt: '{{result_0}}' },
      ],
    }
    const runAgent = vi.fn(async (model: string) => {
      if (model === 'm1') throw new Error('explode')
      return 'fine'
    })
    const out = await runSquad(squad, 't', runAgent)
    expect(out.length).toBe(2)
    expect(out[0].error).toBe(true)
    expect(out[0].result).toContain('explode')
  })

  it('records elapsedMs for each agent', async () => {
    const squad = {
      mode: 'parallel' as const,
      agents: [{ model: 'x', role: 'r', prompt: 'p' }],
    }
    const out = await runSquad(squad, 't', async () => 'ok')
    expect(typeof out[0].elapsedMs).toBe('number')
    expect(out[0].elapsedMs).toBeGreaterThanOrEqual(0)
  })
})

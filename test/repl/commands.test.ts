import { describe, it, expect, vi } from 'vitest'
import { handleCommand, type CommandContext } from '../../src/repl/commands.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    brain: {
      getState: () => ({
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        model: 'claude-haiku-4-5-20251001',
        contextPercent: 5,
        turnCount: 1,
        subscriptions: { anthropic: null, openai: null, google: null },
      } as any),
      reset: vi.fn(),
    },
    model: 'claude-haiku-4-5-20251001',
    setModel: vi.fn(),
    costByModel: () => new Map([
      ['claude-haiku-4-5-20251001', { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, usd: 0.001 }],
    ]),
    history: () => [],
    systemPrompt: () => 'system prompt here',
    sessionId: () => 'sid-test',
    outputStyle: () => 'default',
    setOutputStyle: vi.fn(),
    thinkingCollapsed: () => true,
    setThinkingCollapsed: vi.fn(),
    ...overrides,
  }
}

describe('handleCommand', () => {
  it('returns null for non-slash input', () => {
    expect(handleCommand('hello', makeCtx())).toBeNull()
  })

  it('unknown command returns hint', () => {
    const r = handleCommand('/notreal', makeCtx())
    expect(r?.output).toContain('Unknown command')
  })

  it('/help lists commands', () => {
    const r = handleCommand('/help', makeCtx())
    expect(r?.output).toContain('Available commands')
    expect(r?.output).toContain('/model')
    expect(r?.output).toContain('/exit')
  })

  it('/exit and /quit set exit=true', () => {
    expect(handleCommand('/exit', makeCtx())?.exit).toBe(true)
    expect(handleCommand('/quit', makeCtx())?.exit).toBe(true)
  })

  it('/status shows context and model', () => {
    const r = handleCommand('/status', makeCtx())
    const out = stripAnsi(r!.output)
    expect(out.toLowerCase()).toContain('context')
    expect(out).toContain('claude-haiku')
  })

  it('/clear resets brain', () => {
    const ctx = makeCtx()
    const r = handleCommand('/clear', ctx)
    expect(ctx.brain.reset).toHaveBeenCalled()
    expect(r?.output).toBeTruthy()
  })

  it('/compact returns action=compact', () => {
    expect(handleCommand('/compact', makeCtx())?.action).toBe('compact')
  })

  it('/mcp returns action=mcp', () => {
    expect(handleCommand('/mcp', makeCtx())?.action).toBe('mcp')
  })

  it('/resume returns action=resume', () => {
    expect(handleCommand('/resume', makeCtx())?.action).toBe('resume')
  })

  it('/review returns action=review with reviewRange', () => {
    const r = handleCommand('/review HEAD~3', makeCtx())
    expect(r?.action).toBe('review')
    expect(r?.reviewRange).toBe('HEAD~3')
  })

  it('/undo returns action=undo', () => {
    expect(handleCommand('/undo', makeCtx())?.action).toBe('undo')
  })

  it('/sessions returns action=sessions with args', () => {
    const r = handleCommand('/sessions prune 30', makeCtx())
    expect(r?.action).toBe('sessions')
    expect(r?.sessionsArgs).toBe('prune 30')
  })

  it('/cost shows breakdown', () => {
    const r = handleCommand('/cost', makeCtx())
    expect(r?.output).toBeTruthy()
  })

  it('/cost preview returns output', () => {
    const r = handleCommand('/cost preview hello', makeCtx())
    expect(r?.output).toBeTruthy()
  })

  it('/login returns action=login when provider given', () => {
    const r = handleCommand('/login anthropic', makeCtx())
    expect(r?.action).toBe('login')
    expect(r?.loginProvider).toBe('anthropic')
  })

  it('/login without arg infers provider from model', () => {
    const r = handleCommand('/login', makeCtx())
    expect(r?.action).toBe('login')
    expect(r?.loginProvider).toBe('anthropic')
  })

  it('/style without arg shows current', () => {
    const r = handleCommand('/style', makeCtx())
    expect(stripAnsi(r!.output)).toContain('default')
  })

  it('/style concise sets style', () => {
    const ctx = makeCtx()
    handleCommand('/style concise', ctx)
    expect(ctx.setOutputStyle).toHaveBeenCalledWith('concise')
  })

  it('/style invalid shows error', () => {
    const r = handleCommand('/style weird', makeCtx())
    expect(r?.output.toLowerCase()).toContain('default')
  })

  it('/template returns action=template with args', () => {
    const r = handleCommand('/template save mytmpl', makeCtx())
    expect(r?.action).toBe('template')
    expect(r?.templateArgs).toBe('save mytmpl')
  })

  it('/search returns action=search with query', () => {
    const r = handleCommand('/search keyword', makeCtx())
    expect(r?.action).toBe('search')
    expect(r?.searchQuery).toBe('keyword')
  })

  it('/router returns action=router', () => {
    const r = handleCommand('/router on', makeCtx())
    expect(r?.action).toBe('router')
    expect(r?.routerArg).toBe('on')
  })

  it('/clean returns action=clean', () => {
    expect(handleCommand('/clean', makeCtx())?.action).toBe('clean')
  })

  it('/fork returns action=fork', () => {
    expect(handleCommand('/fork', makeCtx())?.action).toBe('fork')
  })

  it('/repeat returns action=repeat', () => {
    expect(handleCommand('/repeat', makeCtx())?.action).toBe('repeat')
  })

  it('/redact returns action=redact', () => {
    const r = handleCommand('/redact on', makeCtx())
    expect(r?.action).toBe('redact')
    expect(r?.redactArg).toBe('on')
  })

  it('/airplane returns action=airplane', () => {
    expect(handleCommand('/airplane on', makeCtx())?.action).toBe('airplane')
  })

  it('/dispatch returns action=dispatch with body', () => {
    const r = handleCommand('/dispatch @opus: hi', makeCtx())
    expect(r?.action).toBe('dispatch')
    expect(r?.dispatchBody).toContain('@opus')
  })

  it('/squad returns action=squad with args', () => {
    const r = handleCommand('/squad opinions tell me', makeCtx())
    expect(r?.action).toBe('squad')
  })

  it('/checkpoint shows coming soon', () => {
    expect(handleCommand('/checkpoint', makeCtx())?.output).toContain('coming')
  })

  it('/feedback returns text', () => {
    expect(handleCommand('/feedback', makeCtx())?.output).toBeTruthy()
  })
})

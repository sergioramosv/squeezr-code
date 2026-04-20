import { describe, it, expect } from 'vitest'
import { cycleMode, MODE_ORDER, modeColor, modeLabel, renderModeLine, isModifyingTool, isDangerous } from '../../src/repl/mode.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('cycleMode', () => {
  it('cycles default → accept-edits', () => {
    expect(cycleMode('default')).toBe('accept-edits')
  })

  it('cycles accept-edits → plan', () => {
    expect(cycleMode('accept-edits')).toBe('plan')
  })

  it('cycles plan → bypass', () => {
    expect(cycleMode('plan')).toBe('bypass')
  })

  it('cycles bypass → default', () => {
    expect(cycleMode('bypass')).toBe('default')
  })

  it('MODE_ORDER has expected order', () => {
    expect(MODE_ORDER).toEqual(['default', 'accept-edits', 'plan', 'bypass'])
  })
})

describe('modeColor + modeLabel', () => {
  it('returns ANSI color for each mode', () => {
    for (const m of MODE_ORDER) {
      expect(modeColor(m)).toMatch(/\x1b\[\d+m/)
    }
  })

  it('returns labels', () => {
    expect(modeLabel('default')).toBe('default')
    expect(modeLabel('accept-edits')).toBe('accept-edits')
    expect(modeLabel('plan')).toBe('plan mode')
    expect(modeLabel('bypass')).toContain('bypass')
  })
})

describe('renderModeLine', () => {
  it('renders default with no hints (defaults to expand verbs)', () => {
    const out = renderModeLine('default')
    const stripped = stripAnsi(out)
    expect(stripped).toContain('default')
    expect(stripped).toContain('Ctrl+O expand thinking')
    expect(stripped).toContain('Ctrl+T expand tasks')
    expect(stripped).toContain('shift+tab')
  })

  it('shows collapse verb for thinking when expanded', () => {
    const out = renderModeLine('plan', { thinkingExpanded: true })
    expect(stripAnsi(out)).toContain('Ctrl+O collapse thinking')
  })

  it('shows collapse verb for tasks when not collapsed', () => {
    const out = renderModeLine('plan', { tasksCollapsed: false })
    expect(stripAnsi(out)).toContain('Ctrl+T collapse tasks')
  })

  it('shows expand verb for tasks when collapsed=true', () => {
    const out = renderModeLine('plan', { tasksCollapsed: true })
    expect(stripAnsi(out)).toContain('Ctrl+T expand tasks')
  })
})

describe('isModifyingTool', () => {
  it('flags Bash, Write, Edit, NotebookEdit', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
      expect(isModifyingTool(t)).toBe(true)
    }
  })

  it('does not flag Read, Grep', () => {
    expect(isModifyingTool('Read')).toBe(false)
    expect(isModifyingTool('Grep')).toBe(false)
  })
})

describe('isDangerous', () => {
  it('flags expected dangerous tools', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'NotebookEdit']) {
      expect(isDangerous(t)).toBe(true)
    }
  })

  it('does not flag safe tools', () => {
    expect(isDangerous('Read')).toBe(false)
  })
})

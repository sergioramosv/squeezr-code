import { describe, it, expect } from 'vitest'
import {
  renderMdLine, renderCodeLine, renderCodeFence, visibleWidth,
  isTableLine, isTableSeparator, emptyTable, addTableRow, renderTable,
} from '../../src/repl/markdown.js'

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const stripOSC = (s: string) => s.replace(/\x1b\]8;;[^\x07]*\x07([^\x1b]*)\x1b\]8;;\x07/g, '$1')

describe('renderMdLine', () => {
  it('renders H1 with bold + gradient', () => {
    const out = renderMdLine('# Hello')
    expect(stripAnsi(out)).toContain('Hello')
    expect(out).toContain('\x1b[1m') // bold
  })

  it('renders H2 with green color', () => {
    const out = renderMdLine('## Subtitle')
    expect(stripAnsi(out)).toBe('Subtitle')
  })

  it('renders H3', () => {
    const out = renderMdLine('### Sub')
    expect(stripAnsi(out)).toBe('Sub')
  })

  it('renders deeper headings (4-6) with bold no special color', () => {
    const out = renderMdLine('#### x')
    expect(stripAnsi(out)).toBe('x')
  })

  it('renders horizontal rule from ---', () => {
    const out = renderMdLine('---')
    expect(stripAnsi(out)).toContain('─')
  })

  it('renders horizontal rule from *** and ___', () => {
    expect(stripAnsi(renderMdLine('***'))).toContain('─')
    expect(stripAnsi(renderMdLine('___'))).toContain('─')
  })

  it('renders blockquote', () => {
    const out = renderMdLine('> quoted')
    expect(stripAnsi(out)).toContain('quoted')
    expect(stripAnsi(out)).toContain('┃')
  })

  it('renders nested blockquote (>>)', () => {
    const out = renderMdLine('>> double')
    const stripped = stripAnsi(out)
    // Should have ┃ twice
    const count = (stripped.match(/┃/g) || []).length
    expect(count).toBe(2)
  })

  it('renders bullet list with -', () => {
    const out = renderMdLine('- item')
    expect(stripAnsi(out)).toContain('• item')
  })

  it('renders bullet list with *', () => {
    const out = renderMdLine('* item')
    expect(stripAnsi(out)).toContain('• item')
  })

  it('renders bullet list with +', () => {
    const out = renderMdLine('+ item')
    expect(stripAnsi(out)).toContain('• item')
  })

  it('renders numbered list', () => {
    const out = renderMdLine('1. item')
    expect(stripAnsi(out)).toContain('1.')
    expect(stripAnsi(out)).toContain('item')
  })

  it('renders bold inline', () => {
    const out = renderMdLine('this is **bold** text')
    expect(out).toContain('\x1b[1m')
    expect(stripAnsi(out)).toBe('this is bold text')
  })

  it('renders __underscore bold__', () => {
    const out = renderMdLine('__bold__')
    expect(out).toContain('\x1b[1m')
  })

  it('renders italic inline', () => {
    const out = renderMdLine('an *italic* word')
    expect(out).toContain('\x1b[3m')
    expect(stripAnsi(out)).toBe('an italic word')
  })

  it('renders _underscore italic_', () => {
    const out = renderMdLine('_italic_')
    expect(out).toContain('\x1b[3m')
  })

  it('renders inline code', () => {
    const out = renderMdLine('use `npm install`')
    expect(stripAnsi(out)).toContain('`npm install`')
    expect(out).toContain('\x1b[35m') // magenta
  })

  it('renders link [text](url)', () => {
    const out = renderMdLine('[click](https://example.com)')
    const cleaned = stripOSC(stripAnsi(out))
    expect(cleaned).toContain('click')
  })

  it('preserves plain line', () => {
    const out = renderMdLine('just plain text')
    expect(stripAnsi(out)).toBe('just plain text')
  })
})

describe('renderCodeLine', () => {
  it('wraps line in dim+cyan ANSI', () => {
    const out = renderCodeLine('const x = 1')
    expect(out).toContain('const x = 1')
    expect(out).toContain('\x1b[2m')
    expect(out).toContain('\x1b[36m')
  })
})

describe('renderCodeFence', () => {
  it('opening with language', () => {
    const out = renderCodeFence('typescript', true)
    expect(out).toContain('typescript')
  })

  it('opening without language', () => {
    const out = renderCodeFence('', true)
    expect(out).toContain('code')
  })

  it('closing fence', () => {
    const out = renderCodeFence('', false)
    expect(stripAnsi(out)).toContain('└')
  })
})

describe('visibleWidth', () => {
  it('returns plain string length', () => {
    expect(visibleWidth('hello')).toBe(5)
  })

  it('strips ANSI', () => {
    expect(visibleWidth('\x1b[1mhello\x1b[0m')).toBe(5)
  })

  it('returns 0 for empty', () => {
    expect(visibleWidth('')).toBe(0)
  })
})

describe('isTableLine', () => {
  it('detects table row', () => {
    expect(isTableLine('| a | b |')).toBe(true)
  })

  it('rejects non-table line', () => {
    expect(isTableLine('plain text')).toBe(false)
  })

  it('rejects too short', () => {
    expect(isTableLine('||')).toBe(false)
  })
})

describe('isTableSeparator', () => {
  it('detects basic separator', () => {
    expect(isTableSeparator('| --- | --- |')).toBe(true)
  })

  it('detects centered alignment', () => {
    expect(isTableSeparator('| :---: | ---: |')).toBe(true)
  })

  it('rejects content row', () => {
    expect(isTableSeparator('| foo | bar |')).toBe(false)
  })
})

describe('table render flow', () => {
  it('builds and renders a 2-column table', () => {
    const t = emptyTable()
    addTableRow(t, '| col1 | col2 |')
    addTableRow(t, '| --- | --- |')
    addTableRow(t, '| a | b |')
    const out = renderTable(t)
    const stripped = stripAnsi(out)
    expect(stripped).toContain('col1')
    expect(stripped).toContain('col2')
    expect(stripped).toContain('a')
    expect(stripped).toContain('b')
    expect(stripped).toContain('┌')
    expect(stripped).toContain('└')
  })

  it('emptyTable returns no rows', () => {
    expect(emptyTable().rows.length).toBe(0)
  })

  it('renderTable returns empty string for empty state', () => {
    expect(renderTable(emptyTable())).toBe('')
  })

  it('addTableRow returns false for non-table line', () => {
    const t = emptyTable()
    expect(addTableRow(t, 'plain text')).toBe(false)
  })

  it('addTableRow returns true for separator and parses alignments', () => {
    const t = emptyTable()
    addTableRow(t, '| h |')
    expect(addTableRow(t, '| :---: |')).toBe(true)
    expect(t.aligns).toEqual(['center'])
    expect(t.hasHeader).toBe(true)
  })

  it('parses right-only and left-only alignments', () => {
    const t = emptyTable()
    addTableRow(t, '| a | b |')
    addTableRow(t, '| ---: | :--- |')
    expect(t.aligns).toEqual(['right', 'left'])
  })
})

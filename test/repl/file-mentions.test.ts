import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { expandFileMentions } from '../../src/repl/file-mentions.js'

describe('expandFileMentions', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-mentions-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('expands @relative path to file content', () => {
    fs.writeFileSync(path.join(tmp, 'foo.txt'), 'hello world')
    const r = expandFileMentions('see @foo.txt please', tmp)
    expect(r.prompt).toContain('hello world')
    expect(r.prompt).toContain('--- foo.txt ---')
    expect(r.filesIncluded).toContain('foo.txt')
    expect(r.filesNotFound).toEqual([])
  })

  it('expands @subdir/file', () => {
    fs.mkdirSync(path.join(tmp, 'sub'))
    fs.writeFileSync(path.join(tmp, 'sub', 'a.ts'), 'export const x = 1')
    const r = expandFileMentions('check @sub/a.ts', tmp)
    expect(r.prompt).toContain('export const x = 1')
    expect(r.filesIncluded).toContain('sub/a.ts')
  })

  it('expands @/abs/path', () => {
    const abs = path.join(tmp, 'abs.md')
    fs.writeFileSync(abs, '# heading')
    const r = expandFileMentions(`view @${abs}`, '/tmp')
    expect(r.prompt).toContain('# heading')
  })

  it('records file not found', () => {
    const r = expandFileMentions('@./nonexistent.txt', tmp)
    expect(r.filesNotFound).toContain('./nonexistent.txt')
    expect(r.prompt).toContain('@./nonexistent.txt') // left literal
  })

  it('does not match @model (no dot/slash/tilde)', () => {
    const r = expandFileMentions('@opus tell me', tmp)
    // @opus has no /, ., ~ — should NOT be treated as file mention
    expect(r.filesIncluded).toEqual([])
    expect(r.filesNotFound).toEqual([])
    expect(r.prompt).toBe('@opus tell me')
  })

  it('treats @path.with.dot as file', () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '# title')
    const r = expandFileMentions('@README.md', tmp)
    expect(r.filesIncluded).toContain('README.md')
  })

  it('expands directory listing when path matches a dir', () => {
    fs.mkdirSync(path.join(tmp, 'mydir'))
    fs.writeFileSync(path.join(tmp, 'mydir', 'a.txt'), 'x')
    fs.writeFileSync(path.join(tmp, 'mydir', 'b.txt'), 'y')
    // The regex expects something like @./dir or @dir/file — use absolute path which matches /...
    const r = expandFileMentions(`@${path.join(tmp, 'mydir')}`, tmp)
    expect(r.prompt.toLowerCase()).toContain('contents of')
    expect(r.prompt).toContain('a.txt')
    expect(r.prompt).toContain('b.txt')
  })

  it('rejects files over MAX_FILE_BYTES (200KB)', () => {
    const big = path.join(tmp, 'big.txt')
    fs.writeFileSync(big, 'a'.repeat(300_000))
    const r = expandFileMentions('@big.txt', tmp)
    expect(r.filesNotFound.some(f => f.includes('big.txt'))).toBe(true)
    expect(r.filesIncluded).toEqual([])
  })

  it('strips trailing punctuation from path', () => {
    fs.writeFileSync(path.join(tmp, 'doc.md'), 'hi')
    const r = expandFileMentions('see @doc.md.', tmp)
    expect(r.filesIncluded).toContain('doc.md')
  })

  it('handles multiple mentions in one prompt', () => {
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'A')
    fs.writeFileSync(path.join(tmp, 'b.txt'), 'B')
    const r = expandFileMentions('@a.txt and @b.txt', tmp)
    expect(r.filesIncluded.length).toBe(2)
    expect(r.prompt).toContain('A')
    expect(r.prompt).toContain('B')
  })
})

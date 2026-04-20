import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readImageFile } from '../../src/repl/clipboard-image.js'

describe('readImageFile', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-img-'))
  })

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns null for unsupported extension', () => {
    const f = path.join(tmp, 'doc.txt')
    fs.writeFileSync(f, 'not an image')
    expect(readImageFile(f)).toBeNull()
  })

  it('returns null for missing file', () => {
    expect(readImageFile(path.join(tmp, 'nope.png'))).toBeNull()
  })

  it('reads .png file as image/png base64', () => {
    const f = path.join(tmp, 'a.png')
    const data = Buffer.from([137, 80, 78, 71, 13, 10])  // arbitrary bytes
    fs.writeFileSync(f, data)
    const r = readImageFile(f)
    expect(r).not.toBeNull()
    expect(r!.mediaType).toBe('image/png')
    expect(r!.base64).toBe(data.toString('base64'))
  })

  it('reads .jpg as image/jpeg', () => {
    const f = path.join(tmp, 'a.jpg')
    fs.writeFileSync(f, Buffer.from([1, 2, 3]))
    expect(readImageFile(f)!.mediaType).toBe('image/jpeg')
  })

  it('reads .jpeg as image/jpeg', () => {
    const f = path.join(tmp, 'a.jpeg')
    fs.writeFileSync(f, Buffer.from([1, 2, 3]))
    expect(readImageFile(f)!.mediaType).toBe('image/jpeg')
  })

  it('reads .gif as image/gif', () => {
    const f = path.join(tmp, 'a.gif')
    fs.writeFileSync(f, Buffer.from([1, 2, 3]))
    expect(readImageFile(f)!.mediaType).toBe('image/gif')
  })

  it('reads .webp as image/webp', () => {
    const f = path.join(tmp, 'a.webp')
    fs.writeFileSync(f, Buffer.from([1, 2, 3]))
    expect(readImageFile(f)!.mediaType).toBe('image/webp')
  })

  it('rejects file >5MB', () => {
    const f = path.join(tmp, 'huge.png')
    fs.writeFileSync(f, Buffer.alloc(6 * 1024 * 1024))
    expect(readImageFile(f)).toBeNull()
  })

  it('handles uppercase extensions', () => {
    const f = path.join(tmp, 'a.PNG')
    fs.writeFileSync(f, Buffer.from([1]))
    expect(readImageFile(f)!.mediaType).toBe('image/png')
  })
})

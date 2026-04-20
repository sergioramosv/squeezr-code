import { describe, it, expect } from 'vitest'
import { evaluateRules } from '../../src/tools/rules.js'

describe('evaluateRules', () => {
  it('returns ask when no rules match', () => {
    expect(evaluateRules('Read', { file_path: '/x' }, { allow: [], deny: [] })).toBe('ask')
  })

  it('returns ask when rules undefined', () => {
    expect(evaluateRules('Read', {}, {})).toBe('ask')
  })

  it('returns allow when bare tool name matches in allow list', () => {
    expect(evaluateRules('Read', { file_path: '/foo' }, { allow: ['Read'] })).toBe('allow')
  })

  it('returns deny for matching deny rule', () => {
    expect(evaluateRules('Bash', { command: 'rm -rf /' }, { deny: ['Bash'] })).toBe('deny')
  })

  it('deny takes precedence over allow', () => {
    expect(evaluateRules('Bash', { command: 'ls' }, { allow: ['Bash'], deny: ['Bash'] })).toBe('deny')
  })

  it('non-matching tool name → ask', () => {
    expect(evaluateRules('Read', { file_path: '/x' }, { allow: ['Bash'] })).toBe('ask')
  })

  describe('Bash:<command-prefix> patterns', () => {
    it('matches Bash:git *', () => {
      expect(evaluateRules('Bash', { command: 'git status' }, { allow: ['Bash:git *'] })).toBe('allow')
    })

    it('does not match different command', () => {
      expect(evaluateRules('Bash', { command: 'ls -la' }, { allow: ['Bash:git *'] })).toBe('ask')
    })

    it('matches with multiple wildcards', () => {
      expect(evaluateRules('Bash', { command: 'docker run -it ubuntu' }, { allow: ['Bash:docker *'] })).toBe('allow')
    })
  })

  describe('Write:<path-glob> patterns', () => {
    it('matches Write:src/**', () => {
      expect(evaluateRules('Write', { file_path: 'src/foo.ts' }, { allow: ['Write:src/*'] })).toBe('allow')
    })

    it('does not match outside path', () => {
      expect(evaluateRules('Write', { file_path: 'lib/foo.ts' }, { allow: ['Write:src/*'] })).toBe('ask')
    })
  })

  describe('Glob/Grep patterns', () => {
    it('matches Grep on pattern', () => {
      expect(evaluateRules('Grep', { pattern: 'TODO' }, { allow: ['Grep:TODO'] })).toBe('allow')
    })
  })

  it('rule with colon but unknown tool → arg null → no match', () => {
    expect(evaluateRules('Unknown', { x: 'y' }, { allow: ['Unknown:foo'] })).toBe('ask')
  })

  it('empty input still matches bare tool rule', () => {
    expect(evaluateRules('Read', {}, { allow: ['Read'] })).toBe('allow')
  })
})

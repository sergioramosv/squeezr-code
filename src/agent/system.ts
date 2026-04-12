import fs from 'node:fs'
import path from 'node:path'
import type { AgentLoopOpts } from '../api/types.js'

export function buildSystemPrompt(opts: AgentLoopOpts): string {
  const parts: string[] = []

  parts.push(`You are sq, an intelligent CLI agent. You help users with software engineering tasks by reading, writing, and editing files, running commands, and searching codebases.

You have access to these tools: Read, Write, Edit, Bash, Glob, Grep.

Rules:
- Read files before modifying them.
- Use Edit for small changes (string replacement). Use Write only for new files or full rewrites.
- Prefer editing existing files over creating new ones.
- Be concise. Don't add unnecessary comments or documentation unless asked.
- When running Bash commands, use absolute paths when possible.
- If a tool fails, diagnose the issue before retrying.`)

  // Project context
  parts.push(`\nWorking directory: ${opts.cwd}`)

  // Git context
  const gitBranch = getGitBranch(opts.cwd)
  if (gitBranch) parts.push(`Git branch: ${gitBranch}`)

  // CLAUDE.md / SQ.md memory
  const memoryContent = loadProjectMemory(opts.cwd)
  if (memoryContent) {
    parts.push(`\nProject memory:\n${memoryContent}`)
  }

  // Transplant context
  if (opts.appendSystemPrompt) {
    parts.push(`\n--- Transplant context ---\n${opts.appendSystemPrompt}`)
  }

  return parts.join('\n')
}

function getGitBranch(cwd: string): string | null {
  try {
    const headPath = findGitHead(cwd)
    if (!headPath) return null
    const content = fs.readFileSync(headPath, 'utf-8').trim()
    if (content.startsWith('ref: refs/heads/')) {
      return content.slice('ref: refs/heads/'.length)
    }
    return content.slice(0, 8) // detached HEAD — show short hash
  } catch {
    return null
  }
}

function findGitHead(cwd: string): string | null {
  let dir = cwd
  while (true) {
    const headPath = path.join(dir, '.git', 'HEAD')
    if (fs.existsSync(headPath)) return headPath
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function loadProjectMemory(cwd: string): string | null {
  const candidates = ['SQ.md', 'CLAUDE.md', '.sq.md', '.claude.md']
  for (const name of candidates) {
    const filePath = path.join(cwd, name)
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        if (content.length > 10_000) return content.slice(0, 10_000) + '\n... (truncated)'
        return content
      } catch {
        continue
      }
    }
  }
  return null
}

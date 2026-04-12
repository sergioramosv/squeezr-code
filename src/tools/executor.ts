import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { ToolError } from '../errors.js'

const execAsync = promisify(exec)

const DANGEROUS_TOOLS = ['Bash', 'Write', 'Edit']

export interface ToolExecOpts {
  cwd: string
  permissions: 'default' | 'auto' | 'yolo'
  askPermission?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  opts: ToolExecOpts,
): Promise<string> {

  if (opts.permissions === 'default' && DANGEROUS_TOOLS.includes(name)) {
    if (opts.askPermission) {
      const approved = await opts.askPermission(name, input)
      if (!approved) return 'Tool execution denied by user'
    }
  }

  try {
    switch (name) {
      case 'Read': return toolRead(input)
      case 'Write': return toolWrite(input)
      case 'Edit': return toolEdit(input)
      case 'Bash': return await toolBash(input, opts.cwd)
      case 'Glob': return await toolGlob(input, opts.cwd)
      case 'Grep': return await toolGrep(input, opts.cwd)
      default: return `Unknown tool: ${name}`
    }
  } catch (err) {
    if (err instanceof ToolError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new ToolError(name, msg)
  }
}

function toolRead(input: Record<string, unknown>): string {
  const filePath = input.file_path as string
  if (!filePath) return 'Error: file_path is required'
  if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`

  const stat = fs.statSync(filePath)
  if (stat.isDirectory()) return `Error: ${filePath} is a directory, not a file`
  if (stat.size > 10 * 1024 * 1024) return `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)`

  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const offset = (input.offset as number) || 0
  const limit = (input.limit as number) || 2000

  return lines
    .slice(offset, offset + limit)
    .map((line, i) => `${offset + i + 1}\t${line}`)
    .join('\n')
}

function toolWrite(input: Record<string, unknown>): string {
  const filePath = input.file_path as string
  const content = input.content as string
  if (!filePath) return 'Error: file_path is required'
  if (content === undefined) return 'Error: content is required'

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return `File written: ${filePath}`
}

function toolEdit(input: Record<string, unknown>): string {
  const filePath = input.file_path as string
  const oldStr = input.old_string as string
  const newStr = input.new_string as string
  if (!filePath || !oldStr || newStr === undefined) return 'Error: file_path, old_string, and new_string are required'
  if (!fs.existsSync(filePath)) return `Error: file not found: ${filePath}`

  const content = fs.readFileSync(filePath, 'utf-8')
  if (!content.includes(oldStr)) return 'Error: old_string not found in file'

  const occurrences = content.split(oldStr).length - 1
  if (occurrences > 1) return `Error: old_string found ${occurrences} times — must be unique. Provide more surrounding context.`

  const newContent = content.replace(oldStr, newStr)
  fs.writeFileSync(filePath, newContent)
  return `File edited: ${filePath}`
}

async function toolBash(input: Record<string, unknown>, cwd: string): Promise<string> {
  const command = input.command as string
  if (!command) return 'Error: command is required'
  const timeout = (input.timeout as number) || 120_000

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    })
    let result = stdout
    if (stderr) result += `\nSTDERR:\n${stderr}`
    if (result.length > 50_000) result = result.slice(0, 50_000) + '\n... (output truncated)'
    return result || '(no output)'
  } catch (err: unknown) {
    const e = err as { code?: number; killed?: boolean; stderr?: string; message?: string }
    if (e.killed) return `Command killed: timeout after ${timeout}ms`
    return `Command failed (exit ${e.code ?? '?'}):\n${e.stderr || e.message || 'unknown error'}`
  }
}

async function toolGlob(input: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = input.pattern as string
  if (!pattern) return 'Error: pattern is required'
  const searchPath = (input.path as string) || cwd

  // Use node:fs glob via find command as fallback
  try {
    const { stdout } = await execAsync(
      `find ${JSON.stringify(searchPath)} -type f -name ${JSON.stringify(pattern.replace(/\*\*\//g, ''))} 2>/dev/null | head -200`,
      { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 },
    )
    return stdout.trim() || 'No files matched'
  } catch {
    // Fallback for Windows
    try {
      const { stdout } = await execAsync(
        `dir /s /b ${JSON.stringify(searchPath + '\\' + pattern.replace(/\//g, '\\'))} 2>nul`,
        { cwd, timeout: 10_000, shell: 'cmd.exe', maxBuffer: 1024 * 1024 },
      )
      return stdout.trim() || 'No files matched'
    } catch {
      return 'No files matched'
    }
  }
}

async function toolGrep(input: Record<string, unknown>, cwd: string): Promise<string> {
  const pattern = input.pattern as string
  if (!pattern) return 'Error: pattern is required'
  const searchPath = (input.path as string) || cwd
  const glob = input.glob as string | undefined

  const args = ['--color=never', '-rn']
  if (glob) args.push(`--include=${glob}`)
  args.push(JSON.stringify(pattern), JSON.stringify(searchPath))

  try {
    const { stdout } = await execAsync(
      `grep ${args.join(' ')} 2>/dev/null | head -100`,
      { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 },
    )
    return stdout.trim() || 'No matches found'
  } catch {
    return 'No matches found'
  }
}

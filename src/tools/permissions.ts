import readline from 'node:readline'

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bcurl\b.*\|\s*sh\b/,
]

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(command))
}

export async function askPermission(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })

  let detail = ''
  if (toolName === 'Bash') {
    detail = input.command as string
    const dangerous = isDangerousCommand(detail)
    if (!dangerous) return true // auto-approve safe bash commands
  } else if (toolName === 'Write') {
    detail = input.file_path as string
  } else if (toolName === 'Edit') {
    detail = input.file_path as string
  }

  return new Promise<boolean>((resolve) => {
    const prefix = toolName === 'Bash' && isDangerousCommand(detail) ? '\x1b[31m⚠ DANGEROUS\x1b[0m ' : ''
    process.stderr.write(`\n${prefix}\x1b[33m? Allow ${toolName}:\x1b[0m ${detail}\n`)
    rl.question('  (y)es / (n)o / (a)lways: ', (answer) => {
      rl.close()
      const a = answer.trim().toLowerCase()
      resolve(a === 'y' || a === 'yes' || a === 'a' || a === 'always')
    })
  })
}

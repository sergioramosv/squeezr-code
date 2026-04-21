import { spawn } from 'node:child_process'

/**
 * Cross-platform text → system clipboard.
 *
 *   - Windows: `clip.exe` (built-in, in PATH on every Windows ≥ XP)
 *   - macOS:   `pbcopy` (ships with macOS)
 *   - Linux:   tries `wl-copy` (Wayland) → `xclip` → `xsel`, first one found wins
 *
 * Throws on failure with a message that identifies the platform tool,
 * so the REPL can show a useful error toast instead of silently losing
 * the text. Never rejects on timeout — each tool exits as soon as stdin
 * closes.
 */
export async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform

  const candidates: Array<{ cmd: string; args: string[] }> =
    platform === 'win32'
      ? [{ cmd: 'clip', args: [] }]
      : platform === 'darwin'
      ? [{ cmd: 'pbcopy', args: [] }]
      : [
          // Wayland sessions export this variable. Prefer it when present.
          ...(process.env.WAYLAND_DISPLAY ? [{ cmd: 'wl-copy', args: [] }] : []),
          { cmd: 'xclip', args: ['-selection', 'clipboard'] },
          { cmd: 'xsel', args: ['--clipboard', '--input'] },
          // Fallback for Wayland users who don't have xclip installed.
          { cmd: 'wl-copy', args: [] },
        ]

  let lastErr: Error | null = null
  for (const { cmd, args } of candidates) {
    try {
      await runPipe(cmd, args, text)
      return
    } catch (err) {
      lastErr = err as Error
    }
  }

  throw new Error(
    `Clipboard write failed on ${platform}: ${lastErr?.message ?? 'no helper found'}. ` +
      (platform === 'linux'
        ? 'Install xclip, xsel, or wl-clipboard.'
        : 'Check that the built-in clipboard tool is available.'),
  )
}

function runPipe(cmd: string, args: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''

    child.on('error', err => reject(err))
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString('utf-8')
    })
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`))
    })

    child.stdin.end(stdin, 'utf-8')
  })
}

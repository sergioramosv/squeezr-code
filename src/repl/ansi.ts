/**
 * Helpers ANSI/OSC para el renderer.
 */

/**
 * Hyperlink OSC 8: el texto se muestra subrayado y al ctrl+click abre la URL.
 * Soportado en iTerm2, WezTerm, Windows Terminal, Kitty, etc. Terminales que no
 * lo soporten ignoran las secuencias y muestran solo el texto.
 *
 *   \x1b]8;;<url>\x1b\\<text>\x1b]8;;\x1b\\
 */
export function link(url: string, text?: string): string {
  const t = text || url
  const ESC = '\x1b'
  return `${ESC}]8;;${url}${ESC}\\${t}${ESC}]8;;${ESC}\\`
}

/** Beep ASCII — algunos terminales lo convierten en notificación visual. */
export const BEEP = '\x07'

import { spawn } from 'node:child_process'

/**
 * Notificación nativa del OS — fire-and-forget, no espera.
 * Windows: PowerShell + Toast. macOS: osascript. Linux: notify-send.
 */
export function osNotify(title: string, body: string): void {
  try {
    if (process.platform === 'win32') {
      // Windows Toast vía PowerShell BurntToast no está garantizado. Fallback:
      // RegisterEventSource. Usamos balloon notification simple del CLI:
      const ps = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null; ` +
        `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
        `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
        `$n.BalloonTipTitle = ${JSON.stringify(title)}; ` +
        `$n.BalloonTipText = ${JSON.stringify(body)}; ` +
        `$n.Visible = $true; $n.ShowBalloonTip(5000); ` +
        `Start-Sleep -Seconds 6; $n.Dispose()`
      spawn('powershell.exe', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore' }).unref()
    } else if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('notify-send', [title, body], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    // Si la notificación falla, no rompemos nada — solo era un nice-to-have.
  }
}

/**
 * Gradient para headings importantes. Toma un texto y le aplica los 5 verdes
 * del banner (oscuro → brillante), distribuidos por chars.
 */
const GRADIENT = [
  '\x1b[38;5;22m',
  '\x1b[38;5;28m',
  '\x1b[38;5;34m',
  '\x1b[38;5;40m',
  '\x1b[38;5;46m',
]
export function gradient(text: string): string {
  if (text.length === 0) return text
  const buckets = GRADIENT.length
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const colorIdx = Math.floor((i / text.length) * buckets)
    out += GRADIENT[Math.min(colorIdx, buckets - 1)] + text[i]
  }
  return out + '\x1b[0m'
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, execFile } from 'node:child_process'

/**
 * Lee una imagen del portapapeles del sistema y devuelve { base64, mediaType }.
 * Devuelve null si no hay imagen, o si falla el shell-out (no instalado, etc).
 *
 * Implementaciones por plataforma:
 *   - Windows: PowerShell → `Get-Clipboard -Format Image` y `.Save(path)`.
 *   - macOS:   osascript + `«class PNGf»` → escribe PNG a disco.
 *   - Linux:   `xclip -selection clipboard -t image/png -o > file`.
 */
export function readClipboardImage(opts: { debug?: boolean } = {}): { base64: string; mediaType: string } | null {
  const tmpDir = os.tmpdir()
  const tmpFile = path.join(tmpDir, `sq-clip-${Date.now()}.png`)

  try {
    const platform = process.platform
    if (platform === 'win32') {
      // PowerShell script — System.Drawing explícito por si PowerShell 7.x
      // no lo auto-carga. ContainsImage() antes de GetImage() es más robusto.
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms;
        Add-Type -AssemblyName System.Drawing;
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = [System.Windows.Forms.Clipboard]::GetImage();
          if ($img -ne $null) {
            $img.Save('${tmpFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
            Write-Output 'OK';
          } else {
            Write-Output 'GETIMAGE_NULL';
          }
        } else {
          Write-Output 'NO_IMAGE';
        }
      `.trim()
      let out = ''
      try {
        out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
          encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
        }).trim()
      } catch (err) {
        if (opts.debug) process.stdout.write(`  \x1b[31mpowershell error:\x1b[0m ${err instanceof Error ? err.message : String(err)}\n`)
        return null
      }
      if (opts.debug) process.stdout.write(`  \x1b[2mpowershell dijo:\x1b[0m ${out}\n`)
      if (out !== 'OK') return null
    } else if (platform === 'darwin') {
      // osascript: escribe el PNG del clipboard al tmpFile, o falla si no hay imagen.
      const script = `try
        set png_data to the clipboard as «class PNGf»
        set fp to open for access POSIX file "${tmpFile}" with write permission
        write png_data to fp
        close access fp
      on error
        try
          close access fp
        end try
        return "NO_IMAGE"
      end try
      return "OK"`
      const out = execFileSync('osascript', ['-e', script], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      if (out !== 'OK') return null
    } else {
      // Linux: xclip. Si no está instalado, devuelve null sin ruido.
      try {
        execFileSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], {
          stdio: ['ignore', fs.openSync(tmpFile, 'w'), 'pipe'],
          timeout: 5000,
        })
      } catch {
        // intento wayland
        try {
          execFileSync('wl-paste', ['--type', 'image/png'], {
            stdio: ['ignore', fs.openSync(tmpFile, 'w'), 'pipe'],
            timeout: 5000,
          })
        } catch { return null }
      }
    }

    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) return null
    const buf = fs.readFileSync(tmpFile)
    fs.unlinkSync(tmpFile)
    return { base64: buf.toString('base64'), mediaType: 'image/png' }
  } catch {
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
    return null
  }
}

/**
 * Versión ASYNC: no bloquea el event loop. PowerShell corre en background,
 * typing del usuario queda fluido. Úsala para polling. Para paste explícito
 * (Alt+V, /paste), usa la sync — el bloqueo de 200ms es aceptable porque el
 * usuario explícitamente pidió la operación.
 */
export function readClipboardImageAsync(): Promise<{ base64: string; mediaType: string } | null> {
  return new Promise((resolve) => {
    const tmpDir = os.tmpdir()
    const tmpFile = path.join(tmpDir, `sq-clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    const platform = process.platform

    const cleanup = () => { try { fs.unlinkSync(tmpFile) } catch { /* ignore */ } }

    const parseResult = () => {
      try {
        if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) { cleanup(); resolve(null); return }
        const buf = fs.readFileSync(tmpFile)
        cleanup()
        resolve({ base64: buf.toString('base64'), mediaType: 'image/png' })
      } catch { cleanup(); resolve(null) }
    }

    if (platform === 'win32') {
      const ps = `
        Add-Type -AssemblyName System.Windows.Forms;
        Add-Type -AssemblyName System.Drawing;
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = [System.Windows.Forms.Clipboard]::GetImage();
          if ($img -ne $null) {
            $img.Save('${tmpFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png);
            Write-Output 'OK';
          } else { Write-Output 'NULL' }
        } else { Write-Output 'NONE' }
      `.trim()
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 5000 }, (err, stdout) => {
        if (err || (stdout || '').trim() !== 'OK') { cleanup(); resolve(null); return }
        parseResult()
      })
      return
    }

    if (platform === 'darwin') {
      const script = `try
        set png_data to the clipboard as «class PNGf»
        set fp to open for access POSIX file "${tmpFile}" with write permission
        write png_data to fp
        close access fp
        return "OK"
      on error
        try
          close access fp
        end try
        return "NONE"
      end try`
      execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
        if (err || (stdout || '').trim() !== 'OK') { cleanup(); resolve(null); return }
        parseResult()
      })
      return
    }

    // Linux: xclip → wl-paste fallback. execFile con pipe a fichero via spawn.
    // Simplificamos: intentamos xclip primero con callback, si falla wl-paste.
    const tryCmd = (cmd: string, args: string[], next: () => void) => {
      const fd = fs.openSync(tmpFile, 'w')
      execFile(cmd, args, { timeout: 5000, stdio: ['ignore', fd, 'ignore'] } as unknown as { timeout: number }, (err) => {
        try { fs.closeSync(fd) } catch { /* ignore */ }
        if (err) { next(); return }
        parseResult()
      })
    }
    tryCmd('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], () => {
      tryCmd('wl-paste', ['--type', 'image/png'], () => { cleanup(); resolve(null) })
    })
  })
}

/** Lee una imagen de disco y la devuelve en base64. */
export function readImageFile(filePath: string): { base64: string; mediaType: string } | null {
  try {
    const ext = path.extname(filePath).toLowerCase()
    const mediaType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.png' ? 'image/png'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : null
    if (!mediaType) return null
    const buf = fs.readFileSync(filePath)
    if (buf.length > 5 * 1024 * 1024) return null  // cap 5 MB
    return { base64: buf.toString('base64'), mediaType }
  } catch {
    return null
  }
}

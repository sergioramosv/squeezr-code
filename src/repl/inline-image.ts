/**
 * Protocolo de graphics inline del terminal. Detecta iTerm2 / Kitty / WezTerm
 * y usa la escape sequence que entiendan. Fallback para terminales que no lo
 * soportan (Windows Terminal, xterm, GNOME): no hace nada, el token
 * `[Image #N]` ya da feedback textual al usuario.
 *
 * Protocolos soportados:
 *   - iTerm2    → OSC 1337  inline image protocol
 *   - WezTerm   → compat con iTerm2 (mismo OSC 1337)
 *   - Kitty     → APC_G graphics protocol (más rico pero más código)
 *
 * Claude Code hace lo mismo; sólo imprimen la miniatura en terminales que lo
 * soportan, el resto ve solo el token.
 */

type SupportedProtocol = 'iterm2' | 'kitty' | 'none'

export function detectImageProtocol(): SupportedProtocol {
  const term = process.env.TERM_PROGRAM || ''
  const termLower = term.toLowerCase()
  // iTerm2 y WezTerm emiten TERM_PROGRAM identificable.
  if (termLower.includes('iterm') || termLower.includes('wezterm')) return 'iterm2'
  // Kitty usa TERM=xterm-kitty.
  if ((process.env.TERM || '').includes('kitty')) return 'kitty'
  return 'none'
}

/**
 * Emite los bytes para que el terminal renderice la imagen inline. Devuelve
 * true si lo hizo; false si el terminal no soporta (y el caller debería usar
 * el token `[Image #N]` tal cual).
 *
 * `base64` = PNG/JPEG base64 sin prefijo `data:`.
 * `label`  = texto descriptivo que algunos terminales muestran al hover.
 */
export function renderInlineImage(base64: string, label: string): boolean {
  const proto = detectImageProtocol()
  if (proto === 'none') return false
  if (!process.stdout.isTTY) return false

  if (proto === 'iterm2') {
    // OSC 1337 ; File = [args] : base64 BEL
    // args: name=base64(label), inline=1, width=auto, height=auto, preserveAspectRatio=1
    const name = Buffer.from(label).toString('base64')
    const args = `name=${name};inline=1;preserveAspectRatio=1;width=auto;height=auto`
    process.stdout.write(`\x1b]1337;File=${args}:${base64}\x07\n`)
    return true
  }

  if (proto === 'kitty') {
    // Kitty graphics protocol — transmisión directa en un solo chunk (para
    // imágenes pequeñas). Formato: APC G a=T,f=100,X:<base64> ST.
    // Chunked transmission para imágenes >4kB (Kitty recomienda trocear).
    const CHUNK = 4096
    let remaining = base64
    let first = true
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, CHUNK)
      remaining = remaining.slice(CHUNK)
      const last = remaining.length === 0
      const ctrl = first
        ? (last ? 'a=T,f=100' : 'a=T,f=100,m=1')
        : (last ? 'm=0' : 'm=1')
      process.stdout.write(`\x1b_G${ctrl};${chunk}\x1b\\`)
      first = false
    }
    process.stdout.write('\n')
    return true
  }

  return false
}

/**
 * Atajo: imprime el token `[Image #N]` + (si soportado) la imagen inline,
 * dejándolo como una sola "unidad" visual en el chat.
 */
export function printImagePaste(token: string, base64: string, mediaType: string, sizeKB: number): void {
  const inlineOk = renderInlineImage(base64, token)
  const GRAY = '\x1b[90m'
  const DIM = '\x1b[2m'
  const RESET = '\x1b[0m'
  if (inlineOk) {
    process.stdout.write(`  ${DIM}${token} · ${sizeKB} KB ${mediaType} (inline preview ↑)${RESET}\n`)
  } else {
    process.stdout.write(`  ${GRAY}✓${RESET} ${token} capturada ${DIM}(${sizeKB} KB ${mediaType}, inline preview no soportado por tu terminal)${RESET}\n`)
  }
}

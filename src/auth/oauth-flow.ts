import http from 'node:http'
import crypto from 'node:crypto'
import { exec } from 'node:child_process'
import { URL } from 'node:url'

/**
 * OAuth 2.0 Authorization Code + PKCE flow para clientes públicos (instalados / desktop).
 *
 * Sirve a los 3 providers:
 *   - Anthropic (Claude Code OAuth, sk-ant-oat...)
 *   - OpenAI (Codex CLI OAuth, ChatGPT account)
 *   - Google (Gemini CLI OAuth, suscripción Google AI Pro)
 *
 * Mecánica:
 *   1. Genera code_verifier + code_challenge (PKCE S256)
 *   2. Levanta servidor HTTP en localhost:<puerto-libre>
 *   3. Abre el navegador del usuario al endpoint de authorize del provider
 *   4. Espera el redirect a localhost con ?code=...&state=...
 *   5. Intercambia el code por tokens en el endpoint /token
 *   6. Devuelve los tokens al llamador para que los persista
 *
 * No depende de tener el CLI oficial del provider instalado: el usuario solo
 * necesita un navegador.
 */

export interface OAuthConfig {
  /** Nombre legible del provider para los mensajes en consola y la página de éxito. */
  providerLabel: string
  /** OAuth client_id público del provider (mismo que usa su CLI oficial). */
  clientId: string
  /** Client secret. Vacío para PKCE puro (Anthropic, OpenAI). Requerido por Google. */
  clientSecret?: string
  authorizeUrl: string
  tokenUrl: string
  /** Scopes separados por espacio. */
  scope: string
  /** Si el provider requiere parámetros adicionales en el authorize URL. */
  extraAuthParams?: Record<string, string>
  /** Si el provider requiere parámetros adicionales en el body del /token. */
  extraTokenParams?: Record<string, string>
  /** Puerto fijo en lugar de aleatorio (algunos providers solo aceptan puertos específicos). */
  port?: number
  /**
   * Host del redirect_uri. Default `localhost`. Algunos clientes OAuth de Google
   * exigen explícitamente `127.0.0.1` (Code Assist).
   */
  redirectHost?: string
  /**
   * Path del callback HTTP. Default `/callback`. Code Assist exige `/oauth2callback`.
   * Debe coincidir con lo que el provider tenga registrado en el client OAuth.
   */
  redirectPath?: string
  /**
   * Si el provider NO acepta localhost como redirect (Anthropic), el flow no
   * levanta servidor: abre el navegador, redirige a una URL del provider que
   * muestra el code en pantalla, y el usuario lo pega en el terminal.
   */
  manualCodePaste?: boolean
  /**
   * redirect_uri completo a usar cuando `manualCodePaste = true`.
   * Anthropic exige `https://console.anthropic.com/oauth/code/callback`.
   */
  manualRedirectUri?: string
  /**
   * Algunos providers (Anthropic) esperan el body del /token como JSON con un
   * campo `state` adicional, no como x-www-form-urlencoded. Default: 'form'.
   */
  tokenRequestFormat?: 'form' | 'json'
  /**
   * Anthropic usa el PKCE verifier literal como `state` (no un valor random).
   * Sin esto, el authorize devuelve "Invalid request format" porque su validador
   * espera state == verifier. Default: false (state = random, comportamiento estándar).
   */
  stateIsVerifier?: boolean
  /**
   * Si el body del /token debe incluir el campo `state`. Anthropic lo exige;
   * OpenAI lo rechaza con `Unknown parameter: 'state'`. Default: false.
   */
  includeStateInTokenRequest?: boolean
}

export interface OAuthResult {
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** Segundos hasta expirar (lo que devuelve `expires_in` el token endpoint). */
  expiresIn?: number
  /** Cualquier campo extra que devuelva el provider, sin parsear. */
  raw: Record<string, unknown>
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === 'win32'
    ? `start "" "${url}"`
    : platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`
  try {
    exec(cmd, { windowsHide: true })
  } catch { /* user verá el URL en consola igualmente */ }
}

const SUCCESS_HTML = (provider: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>squeezr-code · ${provider}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0e14;
         color: #e5e8eb; display:flex; align-items:center; justify-content:center;
         height:100vh; margin:0; }
  .card { text-align:center; }
  h1 { font-weight:300; font-size:2rem; margin:0 0 0.5rem; color: #00d4ff; }
  p { opacity:0.7; }
  code { background:#1a1f29; padding:2px 6px; border-radius:4px; }
</style></head>
<body><div class="card">
  <h1>✓ ${provider} autenticado</h1>
  <p>Ya puedes cerrar esta pestaña y volver a tu terminal.</p>
  <p style="margin-top:2rem"><code>squeezr-code</code></p>
</div></body></html>`

const ERROR_HTML = (provider: string, msg: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>squeezr-code · error</title>
<style>body{font-family:sans-serif;background:#0a0e14;color:#ff6b6b;
  display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
.card{text-align:center;max-width:600px;padding:2rem;}</style></head>
<body><div class="card"><h1>✗ Error con ${provider}</h1>
<p>${msg}</p><p style="opacity:0.6">Vuelve al terminal y reintenta.</p>
</div></body></html>`

/**
 * Ejecuta el flow OAuth completo. Bloquea hasta que el usuario autoriza
 * (o cancela). Lanza Error si algo falla.
 *
 * Dos modos:
 *   - localhost callback (default): levanta servidor HTTP y captura el code.
 *   - manualCodePaste: el provider muestra el code en pantalla, el usuario lo pega.
 */
export async function runOAuthFlow(cfg: OAuthConfig): Promise<OAuthResult> {
  if (cfg.manualCodePaste) return runManualPasteFlow(cfg)
  return runLocalhostFlow(cfg)
}

async function runLocalhostFlow(cfg: OAuthConfig): Promise<OAuthResult> {
  const { verifier, challenge } = generatePKCE()
  const state = base64url(crypto.randomBytes(16))

  const host = cfg.redirectHost || 'localhost'
  const callbackPath = cfg.redirectPath || '/callback'

  // Servidor en localhost para recibir el callback
  const port = await new Promise<number>((resolve, reject) => {
    const srv = http.createServer()
    srv.on('error', reject)
    srv.listen(cfg.port || 0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr) resolve(addr.port)
      else reject(new Error('no port'))
      srv.close()
    })
  })

  const redirectUri = `http://${host}:${port}${callbackPath}`

  // URL de autorización
  const authUrl = new URL(cfg.authorizeUrl)
  authUrl.searchParams.set('client_id', cfg.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', cfg.scope)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(cfg.extraAuthParams || {})) {
    authUrl.searchParams.set(k, v)
  }

  // Promesa que resuelve con el code cuando llega el callback
  const codePromise = new Promise<string>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', `http://${host}:${port}`)
        if (!url.pathname.startsWith(callbackPath)) {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        if (error) {
          const desc = url.searchParams.get('error_description') || error
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(ERROR_HTML(cfg.providerLabel, desc))
          srv.close()
          reject(new Error(`OAuth denied: ${desc}`))
          return
        }
        const code = url.searchParams.get('code')
        const returnedState = url.searchParams.get('state')
        if (!code) {
          res.writeHead(400).end('missing code')
          return
        }
        if (returnedState !== state) {
          res.writeHead(400).end('state mismatch')
          srv.close()
          reject(new Error('OAuth state mismatch (posible CSRF)'))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(SUCCESS_HTML(cfg.providerLabel))
        srv.close()
        resolve(code)
      } catch (err) {
        res.writeHead(500).end()
        srv.close()
        reject(err)
      }
    })
    srv.on('error', reject)
    srv.listen(port, '127.0.0.1', () => {
      // Imprime URL primero por si el navegador no abre solo
      process.stdout.write(
        `\n  \x1b[36m▸\x1b[0m abriendo navegador para autenticar con ${cfg.providerLabel}…\n`
        + `  \x1b[2msi no se abre solo, copia este URL:\x1b[0m\n  ${authUrl.toString()}\n\n`
        + `  \x1b[2mesperando callback… Esc o Ctrl+C para cancelar.\x1b[0m\n`,
      )
      openBrowser(authUrl.toString())
    })
    // Cancelación: Esc o Ctrl+C aborta el flow. Arrancamos los listeners de
    // readline temporalmente para evitar el double-echo al volver al REPL.
    const wasRaw = process.stdin.isRaw
    const savedData     = process.stdin.listeners('data').slice()
    const savedKeypress = process.stdin.listeners('keypress').slice()
    for (const l of savedData)     process.stdin.removeListener('data',     l as (...args: unknown[]) => void)
    for (const l of savedKeypress) process.stdin.removeListener('keypress', l as (...args: unknown[]) => void)
    const restoreStdin = () => {
      for (const l of savedData)     process.stdin.on('data',     l as (...args: unknown[]) => void)
      for (const l of savedKeypress) process.stdin.on('keypress', l as (...args: unknown[]) => void)
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
    }

    const onCancel = (chunk: Buffer) => {
      const s = chunk.toString('utf-8')
      if (s === '\x03' || s === '\x1b') {
        process.stdin.removeListener('data', onCancel)
        restoreStdin()
        srv.close()
        reject(new Error('Login cancelado'))
      }
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onCancel)
    // Timeout 5 minutos
    const timer = setTimeout(() => {
      process.stdin.removeListener('data', onCancel)
      restoreStdin()
      srv.close()
      reject(new Error('OAuth timeout: pasaron 5 min sin completar el flow'))
    }, 5 * 60_000)
    // Limpia cuando resolvemos por éxito (el server cierra)
    srv.on('close', () => {
      clearTimeout(timer)
      process.stdin.removeListener('data', onCancel)
      restoreStdin()
    })
  })

  const code = await codePromise

  return exchangeCodeForTokens(cfg, code, state, verifier, redirectUri)
}

/**
 * Flow alternativo para providers que NO aceptan localhost como redirect.
 * Anthropic muestra el code en `console.anthropic.com/oauth/code/callback`
 * después de autorizar; el usuario lo pega en el terminal.
 *
 * El code llega con formato `<code>#<state>` (Anthropic empotra el state como
 * fragment). Lo separamos antes del exchange.
 */
async function runManualPasteFlow(cfg: OAuthConfig): Promise<OAuthResult> {
  if (!cfg.manualRedirectUri) {
    throw new Error('manualCodePaste exige manualRedirectUri')
  }
  const { verifier, challenge } = generatePKCE()
  // Anthropic exige state == verifier. Otros providers usan state aleatorio.
  const state = cfg.stateIsVerifier ? verifier : base64url(crypto.randomBytes(16))
  const redirectUri = cfg.manualRedirectUri

  const authUrl = new URL(cfg.authorizeUrl)
  authUrl.searchParams.set('client_id', cfg.clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', cfg.scope)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(cfg.extraAuthParams || {})) {
    authUrl.searchParams.set(k, v)
  }

  process.stdout.write(
    `\n  \x1b[36m▸\x1b[0m abriendo navegador para autenticar con ${cfg.providerLabel}…\n`
    + `  \x1b[2msi no se abre solo, copia este URL:\x1b[0m\n  ${authUrl.toString()}\n\n`
    + `  \x1b[2mtras autorizar, ${cfg.providerLabel} te mostrará un código en pantalla.\x1b[0m\n`
    + `  \x1b[2mcópialo y pégalo aquí abajo (incluyendo el "#" si aparece).\x1b[0m\n`
    + `  \x1b[2mEsc o Ctrl+C para cancelar.\x1b[0m\n\n`,
  )
  openBrowser(authUrl.toString())

  // Lee una línea de stdin, cancelable con Esc o Ctrl+C
  const pasted = await readLineFromStdin('  code: ')
  if (pasted === null) throw new Error('Login cancelado')
  if (!pasted) throw new Error('Sin code pegado')

  // Anthropic devuelve el code como `<code>#<state>`. Si no tiene `#`, asumimos
  // que es solo el code y usamos el state que generamos.
  const [pastedCode, pastedState = state] = pasted.trim().split('#')
  if (!pastedCode) throw new Error('Code vacío tras parsear')

  return exchangeCodeForTokens(cfg, pastedCode, pastedState, verifier, redirectUri)
}

/**
 * Lee una línea de stdin. Devuelve `null` si el usuario cancela con Esc o Ctrl+C.
 *
 * IMPORTANTE: stdin cuando el REPL está vivo tiene `readline` escuchando
 * `'data'` y `'keypress'` ya adjuntos. Si solo añadimos nuestro listener, cada
 * tecla la procesa readline TAMBIÉN — que hace su propio echo — y el usuario
 * ve cada carácter duplicado ("hhoollaa"). Por eso: arrancamos los listeners
 * de readline mientras estamos activos y los restauramos intactos al cerrar,
 * mismo patrón que el model-picker.
 */
function readLineFromStdin(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    let buf = ''
    let done = false

    const wasRaw = process.stdin.isRaw
    const savedData     = process.stdin.listeners('data').slice()
    const savedKeypress = process.stdin.listeners('keypress').slice()
    for (const l of savedData)     process.stdin.removeListener('data',     l as (...args: unknown[]) => void)
    for (const l of savedKeypress) process.stdin.removeListener('keypress', l as (...args: unknown[]) => void)

    const restoreListeners = () => {
      for (const l of savedData)     process.stdin.on('data',     l as (...args: unknown[]) => void)
      for (const l of savedKeypress) process.stdin.on('keypress', l as (...args: unknown[]) => void)
    }

    /**
     * Tras detectar Enter, escuchamos 50ms más con un "tragabyte" para eat
     * cualquier byte residual del paste (en Windows \n llega a veces en un
     * chunk separado) antes de restaurar los listeners de readline.
     */
    const cleanup = () => {
      done = true
      process.stdin.removeListener('data', onData)
      const swallow = (_c: Buffer) => { /* eat */ }
      process.stdin.on('data', swallow)
      setTimeout(() => {
        process.stdin.removeListener('data', swallow)
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw)
        restoreListeners()
      }, 50)
    }

    const onData = (chunk: Buffer) => {
      if (done) return
      // Los terminales modernos envían bracketed paste mode al pegar con Ctrl+V:
      // \x1b[200~<contenido>\x1b[201~. Si no lo eliminamos, el \x1b inicial
      // se interpreta como ESC y cancela el login. Lo stripamos antes de iterar.
      const s = chunk.toString('utf-8').replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '')
      for (const ch of s) {
        // Ctrl+C o Esc → cancelar
        if (ch === '\x03' || ch === '\x1b') {
          process.stdout.write('\n')
          cleanup()
          resolve(null)
          return
        }
        // Enter → confirmar
        if (ch === '\r' || ch === '\n') {
          process.stdout.write('\n')
          cleanup()
          resolve(buf.trim())
          return
        }
        // Backspace
        if (ch === '\x7f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        // Printable
        if (ch >= ' ' && ch !== '\x7f') {
          buf += ch
          process.stdout.write(ch)
        }
      }
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

async function exchangeCodeForTokens(
  cfg: OAuthConfig,
  code: string,
  state: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthResult> {
  const baseFields: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    code_verifier: verifier,
    ...(cfg.includeStateInTokenRequest ? { state } : {}),
    ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
    ...(cfg.extraTokenParams || {}),
  }

  const useJson = cfg.tokenRequestFormat === 'json'
  const tokenRes = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: useJson
      ? { 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: useJson
      ? JSON.stringify(baseFields)
      : new URLSearchParams(baseFields).toString(),
  })

  const text = await tokenRes.text()
  if (!tokenRes.ok) {
    throw new Error(`Token exchange ${tokenRes.status}: ${text.slice(0, 300)}`)
  }

  let data: Record<string, unknown>
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Token endpoint devolvió no-JSON: ${text.slice(0, 200)}`)
  }

  const accessToken = data.access_token as string | undefined
  if (!accessToken) {
    throw new Error(`Sin access_token en respuesta: ${text.slice(0, 200)}`)
  }

  return {
    accessToken,
    refreshToken: data.refresh_token as string | undefined,
    idToken: data.id_token as string | undefined,
    expiresIn: data.expires_in as number | undefined,
    raw: data,
  }
}

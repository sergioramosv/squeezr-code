import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AuthError } from '../errors.js'
import { runOAuthFlow } from './oauth-flow.js'

// Public OAuth client de Claude Code. Mismo client_id que usa el binario claude.
// El valor por defecto vive en oauth-clients.ts (fuera de git) + env-var fallback.
// Si nada se resuelve → el flujo de login fallará con un mensaje claro.
async function resolveAnthropicClientId(): Promise<string> {
  if (process.env.SQ_ANTHROPIC_CLIENT_ID) return process.env.SQ_ANTHROPIC_CLIENT_ID
  try {
    const mod = await import('./oauth-clients.js')
    if (mod.ANTHROPIC_CLIENT_ID) return mod.ANTHROPIC_CLIENT_ID
  } catch { /* file not present (e.g. cloned from GitHub without it) */ }
  throw new AuthError(
    'anthropic',
    'OAuth client_id missing. Set SQ_ANTHROPIC_CLIENT_ID, or install via npm (`npm i -g squeezr-code`) which ships the defaults.',
  )
}
const ANTHROPIC_CLIENT_ID_PROMISE = resolveAnthropicClientId()

export interface AnthropicCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
  importedFrom?: string
}

export class AnthropicAuth {
  private creds: AnthropicCredentials | null = null
  private storePath = path.join(os.homedir(), '.squeezr-code', 'auth', 'anthropic.json')

  async load(): Promise<boolean> {
    // 1. Own store first
    if (fs.existsSync(this.storePath)) {
      try {
        this.creds = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))
        return true
      } catch {
        // Corrupted store — try import
      }
    }

    // 2. Import from Claude Code
    const claudePath = path.join(os.homedir(), '.claude', '.credentials.json')
    if (fs.existsSync(claudePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(claudePath, 'utf-8'))
        const oauth = raw.claudeAiOauth
        if (!oauth?.accessToken) return false
        this.creds = {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
          subscriptionType: oauth.subscriptionType,
          importedFrom: claudePath,
        }
        this.persist()
        return true
      } catch {
        return false
      }
    }

    return false
  }

  /**
   * OAuth flow completo desde sq (igual que `claude setup-token` pero sin abrir Claude Code).
   * Devuelve `sk-ant-oat...` que la API acepta con el beta `oauth-2025-04-20`.
   */
  async login(): Promise<void> {
    // Anthropic tiene un OAuth flow con varias rarezas propias:
    //   1. NO acepta localhost como redirect. Requiere `console.anthropic.com/oauth/code/callback`.
    //   2. Tras autorizar, muestra el code en pantalla con formato `<code>#<state>`
    //      para que el usuario lo pegue en el terminal.
    //   3. El authorize EXIGE `code=true` como parámetro (sin él: "Invalid request format").
    //   4. El `state` debe ser literalmente el PKCE verifier, NO un valor random
    //      (sin esto también: "Invalid request format" tras autorizar).
    //   5. El /v1/oauth/token espera body JSON, no form-urlencoded.
    // Verificado contra implementaciones third-party como opencode-claude-auth.
    const result = await runOAuthFlow({
      providerLabel: 'Anthropic / Claude',
      clientId: await ANTHROPIC_CLIENT_ID_PROMISE,
      authorizeUrl: 'https://claude.ai/oauth/authorize',
      tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
      scope: 'org:create_api_key user:profile user:inference',
      manualCodePaste: true,
      manualRedirectUri: 'https://console.anthropic.com/oauth/code/callback',
      tokenRequestFormat: 'json',
      stateIsVerifier: true,
      includeStateInTokenRequest: true,
      extraAuthParams: { code: 'true' },
    })
    this.creds = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || '',
      expiresAt: Date.now() + (result.expiresIn || 3600) * 1000,
      subscriptionType: (result.raw.subscription_type as string | undefined),
      importedFrom: 'sq login anthropic',
    }
    this.persist()
  }

  async reimport(): Promise<boolean> {
    const claudePath = path.join(os.homedir(), '.claude', '.credentials.json')
    if (!fs.existsSync(claudePath)) return false
    try {
      const raw = JSON.parse(fs.readFileSync(claudePath, 'utf-8'))
      const oauth = raw.claudeAiOauth
      if (!oauth?.accessToken) return false
      this.creds = {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
        subscriptionType: oauth.subscriptionType,
        importedFrom: claudePath,
      }
      this.persist()
      return true
    } catch {
      return false
    }
  }

  async ensureValid(): Promise<string> {
    if (!this.creds) throw new AuthError('anthropic', 'Not authenticated. Run: sq login anthropic')

    // Token still valid
    if (Date.now() < this.creds.expiresAt - 60_000) {
      return this.creds.accessToken
    }

    // Token expired — try reimport from Claude Code first (it auto-refreshes)
    const reimported = await this.reimport()
    if (reimported && this.creds && Date.now() < this.creds.expiresAt - 60_000) {
      return this.creds.accessToken
    }

    // Reimport didn't help — try OAuth refresh ourselves
    try {
      const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: this.creds!.refreshToken,
        }),
      })

      if (res.ok) {
        const data = await res.json() as { access_token: string; expires_in: number }
        this.creds!.accessToken = data.access_token
        this.creds!.expiresAt = Date.now() + data.expires_in * 1000
        this.persist()
        return this.creds!.accessToken
      }
    } catch {
      // refresh endpoint failed — fall through
    }

    // Nothing worked
    throw new AuthError('anthropic', 'Token expirado y refresh falló. Ejecuta /login anthropic en sq para reautenticar.')
  }

  /** ms hasta que expira el token actual (negativo si ya expiró). null si no hay creds. */
  msUntilExpiry(): number | null {
    if (!this.creds) return null
    return this.creds.expiresAt - Date.now()
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureValid()
    const isOAuth = token.startsWith('sk-ant-oat')
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }
    // Tokens OAuth (importados de Claude Code) requieren el beta de oauth.
    // Sin él, /v1/messages devuelve 401 aunque el token sea válido.
    if (isOAuth) {
      headers['anthropic-beta'] = 'oauth-2025-04-20'
      headers['User-Agent'] = 'claude-cli/1.0.0 (external, squeezr-code)'
    }
    return headers
  }

  /** True si las credenciales actuales son un token OAuth (Claude Code) y no una API key. */
  isOAuthToken(): boolean {
    return !!this.creds?.accessToken?.startsWith('sk-ant-oat')
  }

  isAuthenticated(): boolean {
    return this.creds !== null
  }

  getInfo(): { subscriptionType?: string; expiresAt?: number; importedFrom?: string } | null {
    if (!this.creds) return null
    return {
      subscriptionType: this.creds.subscriptionType,
      expiresAt: this.creds.expiresAt,
      importedFrom: this.creds.importedFrom,
    }
  }

  private persist(): void {
    const dir = path.dirname(this.storePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.storePath, JSON.stringify(this.creds, null, 2))
  }
}

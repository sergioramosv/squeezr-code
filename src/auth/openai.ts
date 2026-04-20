import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AuthError } from '../errors.js'
import { runOAuthFlow } from './oauth-flow.js'

// Public OAuth client de Codex CLI. Mismo client_id que usa el binario codex.
// Valor por defecto en oauth-clients.ts (fuera de git) + env-var fallback.
async function resolveOpenAIClientId(): Promise<string> {
  if (process.env.SQ_OPENAI_CLIENT_ID) return process.env.SQ_OPENAI_CLIENT_ID
  try {
    const mod = await import('./oauth-clients.js')
    if (mod.OPENAI_CLIENT_ID) return mod.OPENAI_CLIENT_ID
  } catch { /* file not present */ }
  throw new AuthError(
    'openai',
    'OAuth client_id missing. Set SQ_OPENAI_CLIENT_ID, or install via npm (`npm i -g squeezr-code`) which ships the defaults.',
  )
}
const OPENAI_CLIENT_ID_PROMISE = resolveOpenAIClientId()

export interface OpenAICredentials {
  accessToken: string
  refreshToken: string
  idToken: string
  accountId: string
  expiresAt: number
  importedFrom?: string
}

export class OpenAIAuth {
  private creds: OpenAICredentials | null = null
  private storePath = path.join(os.homedir(), '.squeezr-code', 'auth', 'openai.json')

  async load(): Promise<boolean> {
    if (fs.existsSync(this.storePath)) {
      try {
        this.creds = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))
        return true
      } catch { /* corrupted */ }
    }

    const codexPath = path.join(os.homedir(), '.codex', 'auth.json')
    if (fs.existsSync(codexPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(codexPath, 'utf-8'))
        if (raw.auth_mode !== 'chatgpt' || !raw.tokens?.access_token) return false
        this.creds = {
          accessToken: raw.tokens.access_token,
          refreshToken: raw.tokens.refresh_token,
          idToken: raw.tokens.id_token,
          accountId: raw.tokens.account_id,
          expiresAt: this.extractExpFromJWT(raw.tokens.access_token),
          importedFrom: codexPath,
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
   * OAuth flow completo desde sq (igual que `codex login`, sin Codex CLI instalado).
   * Devuelve un JWT que vale para WebSocket a chatgpt.com/backend-api/codex/responses.
   */
  async login(): Promise<void> {
    // Codex CLI tiene redirect FIJO en localhost:1455/auth/callback. El client
    // OAuth de Codex solo acepta exactamente esa URI; con puerto/path distintos
    // auth.openai.com responde "unknown_error".
    const openaiClientId = await OPENAI_CLIENT_ID_PROMISE
    const result = await runOAuthFlow({
      providerLabel: 'OpenAI / ChatGPT',
      clientId: openaiClientId,
      authorizeUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      scope: 'openid profile email offline_access',
      port: 1455,
      redirectPath: '/auth/callback',
    })
    if (!result.refreshToken) {
      throw new AuthError('openai', 'OAuth no devolvió refresh_token (¿offline_access denegado?)')
    }
    // accountId viene en el JWT (claim `https://api.openai.com/auth.chatgpt_account_id`)
    const accountId = this.extractAccountIdFromJWT(result.accessToken)
    if (!accountId) {
      throw new AuthError('openai', 'JWT sin chatgpt-account-id (¿cuenta sin ChatGPT Plus/Pro?)')
    }
    this.creds = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      idToken: result.idToken || '',
      accountId,
      expiresAt: this.extractExpFromJWT(result.accessToken),
      importedFrom: 'sq login openai',
    }
    this.persist()
  }

  private extractAccountIdFromJWT(jwt: string): string | null {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
      // El claim oficial está namespaced.
      const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
      const id = auth?.chatgpt_account_id || payload.chatgpt_account_id
      return typeof id === 'string' ? id : null
    } catch {
      return null
    }
  }

  async reimport(): Promise<boolean> {
    const codexPath = path.join(os.homedir(), '.codex', 'auth.json')
    if (!fs.existsSync(codexPath)) return false
    try {
      const raw = JSON.parse(fs.readFileSync(codexPath, 'utf-8'))
      if (raw.auth_mode !== 'chatgpt' || !raw.tokens?.access_token) return false
      this.creds = {
        accessToken: raw.tokens.access_token,
        refreshToken: raw.tokens.refresh_token,
        idToken: raw.tokens.id_token,
        accountId: raw.tokens.account_id,
        expiresAt: this.extractExpFromJWT(raw.tokens.access_token),
        importedFrom: codexPath,
      }
      this.persist()
      return true
    } catch {
      return false
    }
  }

  private extractExpFromJWT(jwt: string): number {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
      return payload.exp * 1000
    } catch {
      return Date.now() + 3600_000 // fallback 1h
    }
  }

  async ensureValid(): Promise<string> {
    if (!this.creds) throw new AuthError('openai', 'Not authenticated. Run: sq login openai')

    if (Date.now() < this.creds.expiresAt - 60_000) {
      return this.creds.accessToken
    }

    // Token expired — reimport from Codex CLI first
    const reimported = await this.reimport()
    if (reimported && this.creds && Date.now() < this.creds.expiresAt - 60_000) {
      return this.creds.accessToken
    }

    // Try OAuth refresh
    try {
      const res = await fetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          client_id: await OPENAI_CLIENT_ID_PROMISE,
          refresh_token: this.creds!.refreshToken,
        }),
      })

      if (!res.ok) throw new Error(`${res.status}`)

      const data = await res.json() as { access_token: string }
      this.creds!.accessToken = data.access_token
      this.creds!.expiresAt = this.extractExpFromJWT(data.access_token)
      this.persist()
      return this.creds!.accessToken
    } catch {
      // fall through
    }

    throw new AuthError('openai', 'Token expirado y refresh falló. Ejecuta /login openai en sq para reautenticar.')
  }

  /** ms hasta que expira el token actual (negativo si ya expiró). null si no hay creds. */
  msUntilExpiry(): number | null {
    if (!this.creds) return null
    return this.creds.expiresAt - Date.now()
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureValid()
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  }

  getAccountId(): string | null {
    return this.creds?.accountId ?? null
  }

  isAuthenticated(): boolean {
    return this.creds !== null
  }

  getInfo(): { expiresAt?: number; importedFrom?: string } | null {
    if (!this.creds) return null
    return { expiresAt: this.creds.expiresAt, importedFrom: this.creds.importedFrom }
  }

  private persist(): void {
    const dir = path.dirname(this.storePath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.storePath, JSON.stringify(this.creds, null, 2))
  }
}

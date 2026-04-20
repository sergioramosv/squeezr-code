import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AuthError } from '../errors.js'
import { runOAuthFlow } from './oauth-flow.js'

// Google CLI OAuth credentials (installed-app / desktop public client — los publica
// Gemini CLI en su binario). Sin el "secret", el grant `refresh_token` devuelve
// 401 invalid_client y el usuario tiene que abrir Gemini CLI cada vez que expira
// el token, por eso lo embebemos (como hace Gemini CLI).
//
// Valor por defecto en oauth-clients.ts (fuera de git para no disparar GitHub
// Push Protection por el prefix GOCSPX-) + env-var fallback.
async function resolveGoogleCreds(): Promise<{ clientId: string; clientSecret: string }> {
  const envId = process.env.SQ_GOOGLE_CLIENT_ID
  const envSecret = process.env.SQ_GOOGLE_CLIENT_SECRET
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret }
  try {
    const mod = await import('./oauth-clients.js')
    if (mod.GOOGLE_CLIENT_ID && mod.GOOGLE_CLIENT_SECRET) {
      return {
        clientId: envId ?? mod.GOOGLE_CLIENT_ID,
        clientSecret: envSecret ?? mod.GOOGLE_CLIENT_SECRET,
      }
    }
  } catch { /* file not present */ }
  throw new AuthError(
    'google',
    'OAuth credentials missing. Set SQ_GOOGLE_CLIENT_ID and SQ_GOOGLE_CLIENT_SECRET, or install via npm (`npm i -g squeezr-code`) which ships the defaults.',
  )
}
const GOOGLE_CREDS_PROMISE = resolveGoogleCreds()

export interface GoogleCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  importedFrom?: string
}

export class GoogleAuth {
  private creds: GoogleCredentials | null = null
  private storePath = path.join(os.homedir(), '.squeezr-code', 'auth', 'google.json')

  async load(): Promise<boolean> {
    if (fs.existsSync(this.storePath)) {
      try {
        this.creds = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))
        return true
      } catch { /* corrupted */ }
    }

    const geminiPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json')
    if (fs.existsSync(geminiPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(geminiPath, 'utf-8'))
        if (!raw.access_token) return false
        this.creds = {
          accessToken: raw.access_token,
          refreshToken: raw.refresh_token,
          expiresAt: raw.expiry_date,
          importedFrom: geminiPath,
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
   * OAuth flow completo desde sq, sin depender de Gemini CLI instalado.
   * Abre navegador, escucha en localhost, intercambia code → tokens, persiste.
   */
  async login(): Promise<void> {
    const { clientId, clientSecret } = await GOOGLE_CREDS_PROMISE
    const result = await runOAuthFlow({
      providerLabel: 'Google / Gemini',
      clientId,
      clientSecret,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      // Scopes idénticos a gemini-cli (sin "openid" — el client OAuth de Code
      // Assist no lo lleva en su consent screen).
      scope: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ].join(' '),
      // Code Assist exige redirect 127.0.0.1 + path /oauth2callback (no localhost,
      // no /callback). Si lo pones distinto: redirect_uri_mismatch / invalid_client.
      redirectHost: '127.0.0.1',
      redirectPath: '/oauth2callback',
      extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    })
    if (!result.refreshToken) {
      throw new AuthError('google', 'OAuth no devolvió refresh_token (¿prompt=consent?)')
    }
    this.creds = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + (result.expiresIn || 3600) * 1000,
      importedFrom: 'sq login google',
    }
    this.persist()
  }

  async reimport(): Promise<boolean> {
    const geminiPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json')
    if (!fs.existsSync(geminiPath)) return false
    try {
      const raw = JSON.parse(fs.readFileSync(geminiPath, 'utf-8'))
      if (!raw.access_token) return false
      this.creds = {
        accessToken: raw.access_token,
        refreshToken: raw.refresh_token,
        expiresAt: raw.expiry_date,
        importedFrom: geminiPath,
      }
      this.persist()
      return true
    } catch {
      return false
    }
  }

  async ensureValid(): Promise<string> {
    if (!this.creds) throw new AuthError('google', 'Not authenticated. Run: sq login google')

    if (Date.now() < this.creds.expiresAt - 60_000) {
      return this.creds.accessToken
    }

    // Token expired — reimport from Gemini CLI first
    const reimported = await this.reimport()
    if (reimported && this.creds && Date.now() < this.creds.expiresAt - 60_000) {
      return this.creds.accessToken
    }

    // Try OAuth refresh
    try {
      const { clientId, clientSecret } = await GOOGLE_CREDS_PROMISE
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: this.creds!.refreshToken,
        }),
      })

      if (!res.ok) throw new Error(`${res.status}`)

      const data = await res.json() as { access_token: string; expires_in: number }
      this.creds!.accessToken = data.access_token
      this.creds!.expiresAt = Date.now() + data.expires_in * 1000
      this.persist()
      return this.creds!.accessToken
    } catch {
      // fall through
    }

    throw new AuthError('google', 'Token expirado y refresh falló. Ejecuta /login google en sq para reautenticar.')
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

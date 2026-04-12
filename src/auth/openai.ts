import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AuthError } from '../errors.js'

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

    const res = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        refresh_token: this.creds.refreshToken,
      }),
    })

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new AuthError('openai', 'Token revoked or expired. Run: sq login openai')
      }
      throw new AuthError('openai', `Token refresh failed: ${res.status} ${res.statusText}`)
    }

    const data = await res.json() as { access_token: string }
    this.creds.accessToken = data.access_token
    this.creds.expiresAt = this.extractExpFromJWT(data.access_token)
    this.persist()
    return this.creds.accessToken
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

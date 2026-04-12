import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AuthError } from '../errors.js'

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

    if (Date.now() < this.creds.expiresAt - 60_000) {
      return this.creds.accessToken
    }

    const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.creds.refreshToken,
      }),
    })

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new AuthError('anthropic', `Token revoked or expired. Run: sq login anthropic`)
      }
      throw new AuthError('anthropic', `Token refresh failed: ${res.status} ${res.statusText}`)
    }

    const data = await res.json() as { access_token: string; expires_in: number }
    this.creds.accessToken = data.access_token
    this.creds.expiresAt = Date.now() + data.expires_in * 1000
    this.persist()
    return this.creds.accessToken
  }

  async getHeaders(): Promise<Record<string, string>> {
    const token = await this.ensureValid()
    return {
      'Authorization': `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    }
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

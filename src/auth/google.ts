import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AuthError } from '../errors.js'

// Google CLI OAuth credentials (public desktop app — same as Gemini CLI)
// These are loaded from env or hardcoded defaults matching the public Gemini CLI client
const GOOGLE_CLIENT_ID = process.env.SQ_GOOGLE_CLIENT_ID || '681255809395-gv7frdsg8or6m2h1miqnm7p53m3r3oig.apps.googleusercontent.com'
const GOOGLE_CLIENT_SECRET = process.env.SQ_GOOGLE_CLIENT_SECRET || ''

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

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: this.creds.refreshToken,
      }),
    })

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new AuthError('google', 'Token revoked or expired. Run: sq login google')
      }
      throw new AuthError('google', `Token refresh failed: ${res.status} ${res.statusText}`)
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

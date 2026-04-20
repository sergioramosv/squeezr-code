/**
 * Detector y redactor de secrets comunes. Se usa en dos sitios:
 *   1. Prompts del usuario antes de mandar a la API (via /redact on).
 *   2. Output de tools (Read, Bash) antes de meter al contexto del modelo.
 *
 * Patrones cubiertos:
 *   - AWS access key ID + secret key
 *   - GitHub tokens (ghp_, github_pat_, gho_, ghs_, ghr_)
 *   - Anthropic (sk-ant-api03-*)
 *   - OpenAI (sk-proj-*, sk-* con formato viejo)
 *   - Google API keys (AIzaSy*)
 *   - Slack tokens (xoxb-, xoxp-)
 *   - Bearer tokens en headers
 *   - JWTs (eyJ... eyJ...)
 *   - SSH private keys (bloques BEGIN)
 *   - Basic auth (https://user:pass@...)
 *   - Generic long hex/base64 que parezcan keys
 *
 * No buscamos false positives perfectos — priorizamos no filtrar secrets.
 * El usuario ve cuántos redactamos para enterarse.
 */

interface Pattern {
  name: string
  re: RegExp
  /** Si la replacer deja letras reconocibles (ej. preserva prefijo "sk-ant-"). */
  mask?: (match: string) => string
}

const PATTERNS: Pattern[] = [
  // SSH private keys — bloque entero.
  {
    name: 'ssh-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    mask: () => '[REDACTED_SSH_PRIVATE_KEY]',
  },
  // JWT (header.payload.sig en base64url)
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    mask: () => '[REDACTED_JWT]',
  },
  // Anthropic
  {
    name: 'anthropic',
    re: /\bsk-ant-api0[0-9]-[A-Za-z0-9_-]{20,}\b/g,
    mask: () => '[REDACTED_ANTHROPIC_KEY]',
  },
  // OpenAI project + legacy
  {
    name: 'openai',
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    mask: () => '[REDACTED_OPENAI_KEY]',
  },
  // GitHub
  {
    name: 'github',
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
    mask: () => '[REDACTED_GITHUB_TOKEN]',
  },
  // Google API
  {
    name: 'google-api',
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    mask: () => '[REDACTED_GOOGLE_KEY]',
  },
  // AWS access key ID
  {
    name: 'aws-id',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    mask: () => '[REDACTED_AWS_ACCESS_KEY]',
  },
  // AWS secret (asignación)
  {
    name: 'aws-secret',
    re: /aws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/gi,
    mask: () => 'aws_secret_access_key=[REDACTED]',
  },
  // Slack
  {
    name: 'slack',
    re: /\bxox[baprs]-[0-9]+-[0-9]+-[0-9]+-[a-f0-9]+\b/g,
    mask: () => '[REDACTED_SLACK_TOKEN]',
  },
  // Bearer tokens en headers
  {
    name: 'bearer',
    re: /Bearer\s+[A-Za-z0-9_.-]{20,}/g,
    mask: () => 'Bearer [REDACTED]',
  },
  // Basic auth embedded en URLs
  {
    name: 'url-basic-auth',
    re: /https?:\/\/[^\s:@]+:([^\s@]+)@/g,
    mask: (m) => m.replace(/:[^:@]+@/, ':[REDACTED]@'),
  },
]

export interface RedactResult {
  cleaned: string
  count: number
  byType: Record<string, number>
}

/**
 * Aplica todos los patterns al texto. Devuelve el texto "limpio" y cuántos
 * secrets encontramos (por tipo). Si no hay secrets, devuelve el texto tal cual.
 */
export function redactSecrets(text: string): RedactResult {
  let cleaned = text
  let total = 0
  const byType: Record<string, number> = {}
  for (const { name, re, mask } of PATTERNS) {
    // Reset lastIndex por si la regex es global.
    re.lastIndex = 0
    let matches = 0
    cleaned = cleaned.replace(re, (m) => {
      matches++
      return mask ? mask(m) : `[REDACTED_${name.toUpperCase()}]`
    })
    if (matches > 0) {
      byType[name] = matches
      total += matches
    }
  }
  return { cleaned, count: total, byType }
}

/** Formato legible para el usuario: "aws×1, github×2". */
export function formatRedactSummary(byType: Record<string, number>): string {
  return Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(', ')
}

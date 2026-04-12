import { loadConfig } from './config.js'
import { startREPL } from './repl/repl.js'
import { getVersion } from './version.js'
import { AuthManager } from './auth/manager.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // --version
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`squeezr-code v${getVersion()}`)
    process.exit(0)
  }

  // sq doctor
  if (args[0] === 'doctor') {
    await runDoctor()
    return
  }

  // sq login [provider]
  if (args[0] === 'login') {
    console.log('OAuth login flow — coming soon')
    console.log('For now, authenticate with Claude Code / Codex / Gemini CLI and sq will import tokens automatically.')
    return
  }

  // sq reimport
  if (args[0] === 'reimport') {
    await runReimport()
    return
  }

  // -p "prompt" (non-interactive mode — TODO)
  if (args.includes('-p')) {
    console.log('Non-interactive mode — coming soon')
    return
  }

  // Default: REPL
  const config = loadConfig()
  await startREPL(config)
}

async function runDoctor(): Promise<void> {
  const auth = new AuthManager()
  const status = await auth.init()

  console.log('\n  Auth:')
  const providers: Array<{ name: string; key: keyof typeof status }> = [
    { name: 'Anthropic', key: 'anthropic' },
    { name: 'OpenAI', key: 'openai' },
    { name: 'Google', key: 'google' },
  ]
  for (const p of providers) {
    const ok = status[p.key]
    const info = auth.getProviderInfo(p.key as any)
    const symbol = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    let detail = ok ? 'authenticated' : 'not authenticated'
    if (info?.importedFrom) detail += ` (imported from ${info.importedFrom})`
    console.log(`    ${p.name.padEnd(12)} ${symbol} ${detail}`)
  }

  console.log('\n  Proxy:')
  try {
    const res = await fetch('http://localhost:8080/health', { signal: AbortSignal.timeout(2000) })
    console.log(`    HTTP :8080   \x1b[32m✓\x1b[0m running`)
  } catch {
    console.log(`    HTTP :8080   \x1b[31m✗\x1b[0m not running`)
  }
  try {
    // MITM proxy doesn't have health endpoint — just check port
    const res = await fetch('http://localhost:8081/', { signal: AbortSignal.timeout(2000) }).catch(() => null)
    console.log(`    MITM :8081   \x1b[33m?\x1b[0m (check manually)`)
  } catch {
    console.log(`    MITM :8081   \x1b[33m?\x1b[0m (check manually)`)
  }

  console.log()
}

async function runReimport(): Promise<void> {
  const auth = new AuthManager()
  await auth.init()
  const result = await auth.reimport()

  console.log('\n  Re-importing tokens from installed CLIs...')
  if (result.anthropic) console.log('    Anthropic  \x1b[32m✓\x1b[0m re-imported from ~/.claude/')
  else console.log('    Anthropic  \x1b[2m— skipped\x1b[0m')
  if (result.openai) console.log('    OpenAI     \x1b[32m✓\x1b[0m re-imported from ~/.codex/')
  else console.log('    OpenAI     \x1b[2m— skipped\x1b[0m')
  if (result.google) console.log('    Google     \x1b[32m✓\x1b[0m re-imported from ~/.gemini/')
  else console.log('    Google     \x1b[2m— skipped\x1b[0m')
  console.log()
}

main().catch((err) => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})

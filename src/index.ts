import { loadConfig } from './config.js'
import { startREPL } from './repl/repl.js'
import { runOneShot, readStdinIfPiped } from './repl/oneshot.js'
import { getVersion } from './version.js'
import { AuthManager } from './auth/manager.js'
import { Session } from './state/session.js'
import { runInit } from './state/init.js'
import { runMcpImport } from './mcp/import-cli.js'
import { isFirstRun, runOnboarding } from './repl/onboarding.js'

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
    await runLogin(args[1])
    return
  }

  // sq reimport
  if (args[0] === 'reimport') {
    await runReimport()
    return
  }

  // sq resume [id]  → reanuda última sesión (o la que indiques por id)
  // sq -c          → shortcut para "sq resume" (continue last)
  if (args[0] === 'resume' || args[0] === '-c' || args[0] === '--continue') {
    await runResume(args[1])
    return
  }

  // sq search "query"  → busca en historial de sesiones
  if (args[0] === 'search') {
    const query = args.slice(1).join(' ')
    if (!query) { console.error('Usage: sq search "query"'); process.exit(1) }
    runSearch(query)
    return
  }

  // sq sessions  → lista sesiones guardadas
  if (args[0] === 'sessions') {
    runListSessions()
    return
  }

  // sq mcp import [--all]  → importa MCPs descubiertos a sq.toml
  if (args[0] === 'mcp' && args[1] === 'import') {
    await runMcpImport({ all: args.includes('--all') })
    return
  }

  // sq init  → genera sq.toml + SQUEEZR.md en el proyecto actual
  if (args[0] === 'init') {
    const { created, skipped } = runInit()
    if (created.length > 0) {
      console.log(`\n  \x1b[32m✓\x1b[0m creado: ${created.map(c => `\x1b[36m${c}\x1b[0m`).join(', ')}`)
    }
    if (skipped.length > 0) {
      console.log(`  \x1b[2msaltado (ya existía):\x1b[0m ${skipped.join(', ')}`)
    }
    console.log(`  \x1b[2medita sq.toml para ajustar modelo default y permisos.\x1b[0m`)
    console.log(`  \x1b[2meditaSQUEEZR.md para documentar convenciones del proyecto.\x1b[0m\n`)
    return
  }

  // -p "prompt" / --prompt "prompt" (non-interactive mode)
  const pIdx = args.findIndex(a => a === '-p' || a === '--prompt')
  if (pIdx >= 0) {
    const prompt = args[pIdx + 1]
    if (!prompt) {
      console.error('Usage: sq -p "prompt"  (o  echo "input" | sq -p "prompt")')
      process.exit(1)
    }
    const modelIdx = args.findIndex(a => a === '--model' || a === '-m')
    const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined
    const stdinContent = await readStdinIfPiped()
    const config = loadConfig()
    await runOneShot(config, { prompt, model, stdinContent: stdinContent || undefined })
    return
  }

  // Default: REPL. Si es primera vez, corre el wizard antes.
  if (isFirstRun() && !args.includes('--skip-onboarding')) {
    const auth = new AuthManager()
    await runOnboarding(auth)
  }
  const config = loadConfig()
  // Classic readline REPL — opt-in via --classic flag.
  if (args.includes('--classic')) {
    await startREPL(config)
    return
  }
  // Default: Ink REPL (pin input bottom, streaming chunks, queuing, history).
  const { startInkRepl } = await import('./repl/ink-repl.js')
  await startInkRepl(config)
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

async function runLogin(provider?: string): Promise<void> {
  const valid = ['anthropic', 'openai', 'google'] as const
  type P = typeof valid[number]
  if (!provider || !(valid as readonly string[]).includes(provider)) {
    console.error('Usage: sq login <anthropic|openai|google>')
    process.exit(1)
  }
  const auth = new AuthManager()
  await auth.init()
  try {
    await auth.login(provider as P)
    console.log(`\n  \x1b[32m✓\x1b[0m ${provider} autenticado`)
  } catch (err) {
    console.error(`\n  \x1b[31m✖\x1b[0m login falló: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

async function runResume(id?: string): Promise<void> {
  const session = id ? Session.load(id) : Session.loadLatest()
  if (!session) {
    console.error(id
      ? `No existe sesión con id ${id}`
      : 'No hay sesiones guardadas todavía. Usa `sq` para empezar una.')
    process.exit(1)
  }
  const config = loadConfig()
  const { startInkRepl } = await import('./repl/ink-repl.js')
  await startInkRepl(config, { resumeSession: session })
}

function runListSessions(): void {
  const list = Session.list()
  if (list.length === 0) {
    console.log('  \x1b[2mNo hay sesiones guardadas todavía.\x1b[0m')
    return
  }
  console.log('\n  Sesiones guardadas:')
  for (const s of list.slice(0, 20)) {
    const ago = formatTimeAgo(s.updatedAt)
    const folder = s.cwd.split(/[\\/]/).pop() || s.cwd
    console.log(`    \x1b[36m${s.id.slice(0, 13)}\x1b[0m  ${ago.padEnd(10)} \x1b[2m${folder}\x1b[0m  \x1b[35m${s.model}\x1b[0m  \x1b[2m${s.turnCount} turnos\x1b[0m`)
  }
  console.log(`\n  Reanuda con: \x1b[36msq resume\x1b[0m  (la última)  o  \x1b[36msq resume <id>\x1b[0m`)
  console.log()
}

function runSearch(query: string): void {
  const list = Session.list()
  if (list.length === 0) {
    console.log('  \x1b[2mNo hay sesiones todavía.\x1b[0m')
    return
  }
  const q = query.toLowerCase()
  let totalHits = 0
  console.log(`\n  Buscando \x1b[36m"${query}"\x1b[0m en ${list.length} sesiones...\n`)
  for (const meta of list) {
    const sess = Session.load(meta.id)
    if (!sess) continue
    const messages = sess.getMessages()
    const matches: Array<{ role: string; snippet: string }> = []
    for (const m of messages) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      const lc = content.toLowerCase()
      const idx = lc.indexOf(q)
      if (idx >= 0) {
        const start = Math.max(0, idx - 40)
        const end = Math.min(content.length, idx + query.length + 60)
        const snippet = (start > 0 ? '…' : '') + content.slice(start, end).replace(/\n/g, ' ') + (end < content.length ? '…' : '')
        matches.push({ role: m.role, snippet })
      }
    }
    if (matches.length === 0) continue
    totalHits += matches.length
    const ago = formatTimeAgo(meta.updatedAt)
    console.log(`  \x1b[36m${meta.id.slice(0, 13)}\x1b[0m  \x1b[2m${ago.padEnd(8)} ${meta.cwd.split(/[\\/]/).pop()}${RESET_C} \x1b[35m${meta.model}\x1b[0m  \x1b[2m${matches.length} matches${RESET_C}`)
    for (const hit of matches.slice(0, 3)) {
      console.log(`    \x1b[2m${hit.role}:\x1b[0m ${hit.snippet}`)
    }
    if (matches.length > 3) console.log(`    \x1b[2m... y ${matches.length - 3} más${RESET_C}`)
  }
  console.log(`\n  \x1b[2m${totalHits} matches en total.${RESET_C}\n`)
}
const RESET_C = '\x1b[0m'

function formatTimeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

main().catch((err) => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})

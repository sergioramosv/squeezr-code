import path from 'node:path'
import { SqAgent } from '../agent/agent.js'
import { AuthManager } from '../auth/manager.js'
import { resolveModelAlias } from './model-picker.js'
import { loadModels } from '../api/models.js'
import type { SqConfig } from '../config.js'

/**
 * Non-interactive mode: un turno, imprime respuesta en stdout, sale.
 *
 *   sq -p "qué hace este fichero"
 *   cat error.log | sq -p "resume los errores"
 *   sq -p "añade tests" --model opus
 *
 * Por defecto imprime solo el texto final (sin banners, sin barras, sin
 * status bar). Pensado para scripts y pipelines.
 */
export async function runOneShot(
  config: SqConfig,
  opts: {
    prompt: string
    model?: string
    stdinContent?: string
  },
): Promise<void> {
  const cwd = process.cwd()

  const auth = new AuthManager()
  const authStatus = await auth.init()

  // Carga catálogo de modelos (para resolver aliases).
  await loadModels(auth, authStatus).catch(() => [])

  const agent = new SqAgent(auth, {
    defaultModel: resolveModelAlias(opts.model || config.agent.default),
    permissions: 'yolo', // en one-shot no hay TTY para preguntar
    rules: config.permissions, // deny rules siguen aplicando incluso en yolo
    recaps: false, // en one-shot no queremos recap (solo output para scripts)
    transplant: {
      warnThreshold: config.transplant.warn_threshold,
      autoThreshold: config.transplant.auto_threshold,
    },
  })

  // Si el provider por defecto no está autenticado, cambiamos a uno que sí.
  const defaultProvider = agent.getCurrentProvider()
  if (!authStatus[defaultProvider]) {
    const available = auth.authenticated()
    if (available.length === 0) {
      process.stderr.write('No providers authenticated. Run: sq login <provider>\n')
      process.exit(1)
    }
    const fallback: Record<string, string> = {
      anthropic: 'sonnet',
      openai: '5.4-mini',
      google: 'pro',
    }
    agent.setModel(resolveModelAlias(fallback[available[0]]))
  }

  const prompt = opts.stdinContent
    ? `${opts.stdinContent}\n\n${opts.prompt}`
    : opts.prompt

  try {
    const events = agent.send(prompt, { cwd })
    for await (const event of events) {
      // Solo imprimimos texto de respuesta (no thinking, tools, etc.)
      if (event.type === 'text' && event.text) {
        process.stdout.write(event.text)
      }
      // Errores al stderr con código de salida distinto.
      if (event.type === 'error' && event.error) {
        process.stderr.write(`\n${event.error}\n`)
      }
    }
    process.stdout.write('\n')
  } finally {
    agent.shutdown()
  }
}

/** Lee todo stdin en una string. Devuelve null si stdin es un TTY (no hay pipe). */
export async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer | string) => {
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
    })
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()))
    process.stdin.on('error', () => resolve(null))
  })
}

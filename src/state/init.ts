import fs from 'node:fs'
import path from 'node:path'

/**
 * `sq init` — escanea el proyecto y genera `sq.toml` + `SQUEEZR.md` con
 * contexto que el agente verá en el system prompt (a partir del momento en que
 * lo leamos en agent/system.ts — por ahora SQUEEZR.md sirve como documento de
 * referencia para el usuario y para `Read` a petición del modelo).
 *
 * Detecta:
 *   - Lenguaje principal (Node, Python, Rust, Go, Java, ...)
 *   - Scripts de npm/pnpm (si hay package.json)
 *   - Presencia de README, CHANGELOG, tests
 *   - Rama git actual
 *   - Comando de build inferido
 */

const SQ_TOML_TEMPLATE = (detected: ProjectInfo): string => `# squeezr-code — configuración del proyecto
# Generado por sq init. Edita a tu gusto.

[agent]
default = "sonnet"              # opus | sonnet | haiku | pro | flash | 5.4-mini | ...
permissions = "default"         # default | auto | yolo

# Reglas granulares — ordenadas por precedencia (deny > allow > pregunta).
# Patrones: "Tool" (cualquier invocación) o "Tool:pattern" con glob (*).
[permissions]
allow = [
  "Read",                       # lecturas siempre OK
  "Glob",
  "Grep",
${detected.buildCommand ? `  "Bash:${detected.buildCommand} *",     # build sin preguntar\n` : ''}${detected.testCommand ? `  "Bash:${detected.testCommand} *",     # tests sin preguntar\n` : ''}  "Bash:git status*",
  "Bash:git diff*",
  "Bash:git log*",
]
deny = [
  "Bash:rm -rf*",               # nunca borrado recursivo
  "Bash:git push --force*",
  "Bash:sudo*",
]

[transplant]
warn_threshold = 80
auto_threshold = 95

[display]
show_cost = true
show_context = true
`

const SQUEEZR_MD_TEMPLATE = (detected: ProjectInfo): string => `# ${detected.name}

${detected.description || '_(añade aquí una descripción breve del proyecto)_'}

## Stack

- **Lenguaje:** ${detected.language}
${detected.framework ? `- **Framework:** ${detected.framework}\n` : ''}${detected.packageManager ? `- **Package manager:** ${detected.packageManager}\n` : ''}

## Comandos

${detected.buildCommand ? `- **Build:** \`${detected.buildCommand}\`\n` : ''}${detected.testCommand ? `- **Tests:** \`${detected.testCommand}\`\n` : ''}${detected.devCommand ? `- **Dev:** \`${detected.devCommand}\`\n` : ''}${detected.lintCommand ? `- **Lint:** \`${detected.lintCommand}\`\n` : ''}
## Estructura

${detected.structure}

## Convenciones

_(documenta aquí el estilo de código, naming, patrones que el agente debería respetar)_

- Ejemplo: usar TypeScript estricto, no añadir \`any\` sin justificar.
- Ejemplo: los comentarios deben explicar el *porqué*, no el *qué*.

## Notas para el agente

Este documento lo lee el agente al arrancar. Añade aquí cualquier contexto que
debería tener presente: dependencias raras, APIs internas, quirks del build, etc.
`

interface ProjectInfo {
  name: string
  description: string
  language: string
  framework?: string
  packageManager?: string
  buildCommand?: string
  testCommand?: string
  devCommand?: string
  lintCommand?: string
  structure: string
}

export function runInit(cwd: string = process.cwd()): { created: string[]; skipped: string[] } {
  const info = detect(cwd)

  const created: string[] = []
  const skipped: string[] = []

  const tomlPath = path.join(cwd, 'sq.toml')
  if (fs.existsSync(tomlPath)) {
    skipped.push('sq.toml')
  } else {
    fs.writeFileSync(tomlPath, SQ_TOML_TEMPLATE(info))
    created.push('sq.toml')
  }

  const mdPath = path.join(cwd, 'SQUEEZR.md')
  if (fs.existsSync(mdPath)) {
    skipped.push('SQUEEZR.md')
  } else {
    fs.writeFileSync(mdPath, SQUEEZR_MD_TEMPLATE(info))
    created.push('SQUEEZR.md')
  }

  return { created, skipped }
}

function detect(cwd: string): ProjectInfo {
  const name = path.basename(cwd)
  let description = ''
  let language = 'desconocido'
  let framework: string | undefined
  let packageManager: string | undefined
  let buildCommand: string | undefined
  let testCommand: string | undefined
  let devCommand: string | undefined
  let lintCommand: string | undefined

  // Node / TypeScript
  const pkgPath = path.join(cwd, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      description = pkg.description || ''
      language = fs.existsSync(path.join(cwd, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript'
      packageManager = fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : fs.existsSync(path.join(cwd, 'yarn.lock'))
          ? 'yarn'
          : 'npm'
      const scripts = (pkg.scripts || {}) as Record<string, string>
      const runner = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : 'npm run'
      if (scripts.build) buildCommand = `${runner} build`
      if (scripts.test) testCommand = `${runner} test`
      if (scripts.dev) devCommand = `${runner} dev`
      if (scripts.lint) lintCommand = `${runner} lint`
      // Framework heurístico
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } as Record<string, string>
      if (deps.next) framework = 'Next.js'
      else if (deps.react) framework = 'React'
      else if (deps.vue) framework = 'Vue'
      else if (deps.express || deps.fastify || deps.hono) framework = 'Node server'
    } catch { /* malformed package.json */ }
  }

  // Python
  if (language === 'desconocido' && fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
    language = 'Python'
    packageManager = fs.existsSync(path.join(cwd, 'uv.lock')) ? 'uv' : fs.existsSync(path.join(cwd, 'poetry.lock')) ? 'poetry' : 'pip'
    testCommand = 'pytest'
  } else if (language === 'desconocido' && fs.existsSync(path.join(cwd, 'requirements.txt'))) {
    language = 'Python'
    packageManager = 'pip'
  }

  // Rust
  if (language === 'desconocido' && fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    language = 'Rust'
    packageManager = 'cargo'
    buildCommand = 'cargo build'
    testCommand = 'cargo test'
  }

  // Go
  if (language === 'desconocido' && fs.existsSync(path.join(cwd, 'go.mod'))) {
    language = 'Go'
    buildCommand = 'go build'
    testCommand = 'go test ./...'
  }

  // Estructura: top-level dirs + files relevantes
  const entries = fs.readdirSync(cwd, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.') && !['node_modules', 'dist', 'build', 'target', '__pycache__'].includes(e.name))
    .slice(0, 30)
  const dirs = entries.filter(e => e.isDirectory()).map(e => `- \`${e.name}/\``)
  const structure = dirs.length > 0 ? dirs.join('\n') : '_(proyecto en un solo fichero o estructura plana)_'

  return { name, description, language, framework, packageManager, buildCommand, testCommand, devCommand, lintCommand, structure }
}

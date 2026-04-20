# squeezr-code

> The intelligent CLI that never loses context.

`sq` es un agente CLI interactivo que habla **directo** con las APIs privadas de Anthropic, OpenAI/Codex y Google/Gemini usando los mismos OAuth tokens que Claude Code, Codex CLI y Gemini CLI. **No es un wrapper** de ninguno de ellos: tu suscripción de Claude Pro / ChatGPT Plus / Gemini Pro se consume desde sq igual que se consumiría desde el CLI oficial.

## Features

- **3 providers OAuth** — Claude (REST + SSE), ChatGPT/Codex (WebSocket sobre `chatgpt.com`), Gemini (Code Assist API).
- **Login OAuth propio** (`sq login` / `/login`) — abre navegador, PKCE + localhost callback. No necesitas tener Claude Code / Codex / Gemini CLI instalados.
- **Auto-refresh proactivo** de tokens en background — sq refresca los que estén a punto de caducar mientras usas el REPL, nunca te come un prompt por auth expirada estando idle.
- **Prompt inline ante auth expirada** — si algo falla por auth, sq pregunta `¿reauth con /login X? [Y/n]` y dispara el flow sin que salgas del REPL.
- **Memoria multi-turn real** con persistencia de sesión. `sq resume` reanuda la última conversación con historial intacto. `sq sessions` lista todas.
- **Picker interactivo** de modelo con `↑↓ + enter` (`/model`).
- **Catálogo dinámico** de modelos: se consulta `/v1/models` de cada provider y se cachea 1h en `~/.squeezr-code/models-cache.json`. Cuando sale Opus 4.8 o Gemini 4 Pro aparece solo, sin tocar código.
- **Aliases dinámicos** — `opus`, `sonnet`, `haiku`, `pro`, `flash` apuntan siempre al último de cada familia. También versionados (`opus-4.7`, `sonnet-4.6`, `pro-3.0`, `5.4-mini`, `5-codex`).
- **% real de la suscripción** por provider (ventana 5h y 7d) leído de los headers de cada respuesta. Status bar y `/status` muestran el del modelo actual y se actualizan al cambiar de modelo.
- **22 tools built-in** — Read (+ PDF), Write, Edit, Bash (con background), BashOutput, KillShell, Glob, Grep (ripgrep-style), WebFetch, WebSearch, TaskCreate/List/Get/Update, NotebookEdit, AskUserQuestion, Task (sub-agentes), ExitPlanMode, **Monitor**, **CronCreate/List/Delete**, **EnterWorktree/ExitWorktree**.
- **Historial de prompts persistente** entre sesiones (`↑/↓`) + autocompletado `TAB` para comandos, aliases y `@modelo`.
- **Status bar git-aware** — muestra `proyecto/branch*` cuando estás dentro de un repo.
- **Comandos** `/clear`, `/compact`, `/status`, `/cost`, `/login`, `/model list`, `/help`.
- **Thinking blocks** — razonamiento interno del modelo (Claude 4.5+, Gemini 3, Codex o3) en gris bajo `✻`. No se persiste.
- **Diffs visuales** antes de aplicar `Write` / `Edit` — ves el cambio exacto con `+/-` coloreado y apruebas con conocimiento.
- **Permisos granulares** — `[permissions]` con `allow`/`deny` en `sq.toml`. `"Bash:git *"` sí, `"Bash:rm -rf*"` no.
- **Non-interactive mode** — `sq -p "prompt"` para scripts, `cat log | sq -p "resume errores"` para pipes.
- **MCP servers** — soporta Model Context Protocol. Declara en `[mcp.<name>]` y sq expone sus tools al agente.
- **`sq init`** — genera `sq.toml` + `SQUEEZR.md` adaptados al proyecto (detecta lenguaje, framework, scripts).
- **Errores legibles** — auth expirada, rate limit, Cloudflare, sin red, etc., con sugerencia accionable en lugar de stack trace.
- **Banner ASCII** y bloques visuales por turno estilo Claude Code.
- **Multimodal** — `/paste [texto]` lee imagen del portapapeles (Windows/macOS/Linux) y la manda al modelo. Sin dependencias — usa PowerShell / osascript / xclip nativos.
- **Plan mode con aprobación explícita** — `shift+tab` a plan mode → el agente investiga y llama `ExitPlanMode(plan)` para pedir OK. Al aprobar, salta a `accept-edits` y se pone a implementar.
- **Prompt caching automático (Anthropic)** — tools + system van con `cache_control: ephemeral`. Con 10 turnos ahorra ~70% del gasto en input tokens.
- **Auto-compact** cuando el contexto supera el umbral (default 95%). Sin intervención manual.
- **Extended thinking por keywords** — escribe `think hard` / `ultrathink` en el prompt y Anthropic activa razonamiento extendido con budget 10k / 32k tokens.
- **PDF reading** — `Read` extrae texto de PDFs (pdf-parse). Rangos via `pages: "1-5"` para PDFs grandes, cap 20 páginas por call.
- **Auto-update check** — al arrancar avisa si hay versión nueva en npm. Cache 24h, sin espiar ni reportar nada.
- **Output styles** — `/style concise` corta las respuestas al mínimo, `/style explanatory` las hace pedagógicas, `/style default` balance.
- **Cron scheduling** — el agente puede programar prompts al futuro (`CronCreate`), listar/borrar. Syntax estándar `M H DoM Mon DoW`. In-memory (o durable con `durable=true`).
- **Monitor tool** — `Monitor({ command, filter, timeout_ms })` ejecuta un shell command, filtra stdout+stderr por regex, devuelve solo las líneas que importan. Para ver errores de builds, tests que fallan, etc.
- **Worktrees integrados** — `EnterWorktree` crea `.claude/worktrees/<name>/` con branch nueva y cambia el cwd del REPL. `ExitWorktree` sale limpio (con chequeo de cambios sin commit).
- **Audit logs opt-in** — JSONL append-only en `~/.squeezr-code/audit.log` con cada tool ejecutada. Para compliance / debugging / B2B. Activa con `[audit] enabled = true` en config.toml.
- **Session history** — `/history [N]` muestra los últimos turnos. Sesiones persisten indefinidamente por defecto; `/sessions retain N` configura auto-prune a N días.

## Install

```bash
npm install -g squeezr-code
```

## Quick start

```bash
sq                              # REPL interactivo (crea sesión nueva)
sq init                         # genera sq.toml + SQUEEZR.md en el proyecto
sq resume                       # reanuda la última sesión
sq sessions                     # lista sesiones guardadas
sq --model opus                 # arranca con Opus
sq -p "prompt"                  # non-interactive: responde y sale
cat log | sq -p "resume errores"  # pipe stdin al prompt
sq doctor                       # comprueba auth + providers detectados
sq login google                 # login OAuth desde cero (abre navegador)
@pro explica este fichero       # override puntual a Gemini Pro
```

## Auth

Dos formas equivalentes de autenticar:

**Opción A — login OAuth desde sq (recomendado)**

```bash
sq login anthropic     # abre claude.ai en el navegador
sq login openai        # abre auth.openai.com
sq login google        # abre accounts.google.com
```

También disponible dentro del REPL como `/login [provider]`. Si un request falla por auth expirada, sq te pregunta inline si quieres reauth.

**Opción B — importar desde CLIs oficiales**

Si ya tienes Claude Code / Codex / Gemini CLI autenticado, sq importa el token automáticamente en el primer arranque:

| Provider | Origen | Refrescar con |
|---|---|---|
| Anthropic | `~/.claude/.credentials.json` | `claude setup-token` o `sq login anthropic` |
| OpenAI / Codex | `~/.codex/auth.json` | `codex login` o `sq login openai` |
| Google / Gemini | `~/.gemini/oauth_creds.json` | `gemini auth` o `sq login google` |

Los tokens se guardan en `~/.squeezr-code/auth/` y se auto-refrescan en background. Para forzar reimportar desde los CLIs:

```bash
sq reimport            # los tres
sq reimport google     # solo uno
```

## Comandos

| Comando | Descripción |
|---|---|
| `/model` | Picker interactivo (`↑↓ + enter`) |
| `/model <alias>` | Cambia modelo directamente (`/model opus`, `/model pro`...) |
| `/model list` | Lista todos los modelos disponibles |
| `/status` | % contexto, % suscripción 5h y 7d, modelo, coste |
| `/cost` | Desglose de coste por modelo en esta sesión (tokens in/out + USD) |
| `/clear` | Borra el historial multi-turn (no toca auth) |
| `/resume` | Picker de sesiones guardadas — reanuda una conversación previa |
| `/review [rango]` | Review estilo PR del `git diff` (staged + unstaged por defecto, o rango tipo `HEAD~3`) |
| `/undo` | Revierte el último `Edit` o `Write` de la sesión actual |
| `/sessions` · `/sessions prune [N]` · `/sessions retain N` | Inspecciona / poda / configura retención de sesiones guardadas |
| `/paste [texto]` | Lee imagen del portapapeles (screenshot) y la envía al modelo con prompt opcional |
| `/login [provider]` | Re-autentica OAuth (sin argumento infiere del modelo actual) |
| `/help` | Lista comandos |
| `/exit` · `/quit` | Salir |
| `@alias prompt` | Override puntual de modelo (`@opus explica...`, `@5.4-mini resume...`, `@pro lee...`) |
| `@path/to/file` | Mete el contenido del fichero en el prompt. `TAB` autocompleta paths. |

## Aliases de modelo

| Alias | Resuelve a |
|---|---|
| `opus` / `sonnet` / `haiku` | Último Anthropic de esa familia |
| `pro` / `flash` | Último Gemini de esa familia |
| `opus-4.7`, `sonnet-4.6`, `haiku-4.5` | Versión exacta Anthropic |
| `pro-3.0`, `flash-3.0` | Versión exacta Google |
| `5.4`, `5.4-mini`, `5-codex`, `5.3-codex` | Modelos Codex (sin prefijo `gpt-`) |
| `claude-opus-4-7`, `gpt-5.4-mini`, `gemini-3-pro` | ID completo del provider |

## Troubleshooting

| Síntoma | Probable causa | Fix |
|---|---|---|
| `Token rechazado por anthropic (401)` | OAuth expirado | `/login anthropic` dentro del REPL, o `sq login anthropic` |
| `Auth de google expirada` | Refresh token caducado | `/login google` — abre el navegador y vuelves en 10 segundos |
| `Bloqueado por Cloudflare (403)` en Codex | VPN o red corporativa filtrando `chatgpt.com` | Probar otra red o desactivar VPN |
| Picker `/model` vacío | Catálogo aún no cargado en cold start | Esperar 1-2s, o cerrar y reabrir sq |
| `loadCodeAssist failed` en primer `@pro` | Cuenta sin proyecto Google Cloud vinculado | sq intenta `onboardUser` automáticamente; si falla, abrir una vez `gemini` y repetir |

## Arquitectura

`sq` habla directo con las APIs de cada provider — no es un wrapper de ningún CLI. El OAuth se importa de los CLIs oficiales (Claude Code / Codex / Gemini) pero las peticiones salen de sq. El "agentic loop" es propio: tools, permisos, retry, brain de contexto, todo vive aquí. La compresión vía [squeezr-ai](https://github.com/sergioramosv/squeezr-ai) se integrará como peer-dependency opcional en una fase posterior.

## Requirements

- Node.js >= 18
- Al menos uno autenticado: [Claude Code](https://claude.com/claude-code), [Codex CLI](https://github.com/openai/codex), o [Gemini CLI](https://github.com/google-gemini/gemini-cli)

## License

MIT

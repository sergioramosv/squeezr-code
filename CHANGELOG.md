# Changelog

Todos los cambios notables de `squeezr-code` se documentan aquí.
Formato basado en [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versionado según [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- **Scroll del terminal roto en el Ink REPL:** con la rueda del ratón no se
  podía scrollear mensajes largos. Causa raíz: todo el historial se
  renderizaba dentro de componentes Ink normales, que React repinta en cada
  update (cada token de streaming, cada cambio de estado) — el terminal no
  puede mantener scrollback estable sobre un área que no para de repintarse.
  **Fix:** el historial de mensajes se envuelve en el componente `<Static>`
  de Ink. Cada línea completa se emite al stdout **una sola vez** y no se
  repinta jamás, así el scrollback nativo del terminal la retiene y la
  rueda del ratón / Shift+PgUp-PgDn funcionan. Sólo el "área viva"
  (tokens en streaming, spinner, pickers, status bar, input) permanece
  dentro del render dinámico. Los tokens que aún no han llegado a `\n` se
  muestran como `liveText` en el área dinámica, así se sigue viendo el
  flujo de escritura de la IA en tiempo real.
- **Paginador interno Ctrl+U/D retirado:** ya no hace falta ahora que el
  terminal gestiona el scrollback. Las teclas se consumen para no ensuciar
  el input, pero no tienen efecto. Help overlay actualizado.
- **Context % rebasaba 100%** (p.ej. "102%") cuando Anthropic reportaba
  burst allowance por encima del soft-limit o cuando el modelo era un
  Sonnet 4.5/4.6 (1M context) y la tabla interna asumía 200K. Tabla de
  modelos extendida + pattern match para `claude-sonnet-4-[5-9]-*` → 1M.
  Además, todos los renders del % cap a 100 con sufijo `!` para señalar
  "estás al tope" sin mentir con un número imposible.
- **Secrets en el repo:** client IDs de OAuth (Anthropic, OpenAI, Google)
  y el client_secret `GOCSPX-*` de Gemini CLI vivían hardcoded en
  `src/auth/*.ts`, disparando GitHub Push Protection. Movidos a
  `src/auth/oauth-clients.ts` (git-ignored, pero incluido en el tarball
  de npm vía `.npmignore` — `sq login` sigue funcionando out-of-the-box
  después de `npm i -g`). Fixtures del test de redacción (`redact.test.ts`)
  tokenizados con `tok('xo', 'xb-')` para no dejar literales que el
  scanner de GitHub flaggee, sin perder la validez del test.

### Próximo
- **Auto-routing** inteligente por clasificación del prompt.
- **Integración real con `squeezr-ai`** (compresión de contexto vía proxy).
- **Parallel sub-agents** (requiere refactor del event stream).
- **UI refactor con ink** — pin input bottom, scroll navigable, diff side-by-side.
- **IDE plugins** (VSCode, JetBrains).
- **Audit logs** opcionales (JSONL append-only de cada tool ejecutada) para B2B/compliance.
- **Bedrock + Vertex adapters** para empresas que no pueden hablar directo con las APIs.

## [0.84.46] - 2026-04-19

### Added
- **Sistema de Skills (custom commands):** las skills son ficheros `.md` en `~/.squeezr-code/commands/` que se invocan como `/nombre [argumentos]`. `$ARGS` se reemplaza por lo que escribas tras el comando. Ahora también funcionan en el Ink REPL (antes solo en `--classic`).
- **Skills predefinidas instaladas con squeezr** (en `skills/`, se copian a `~/.squeezr-code/commands/` al primer arranque):
  - `/uiux` — revisión UI/UX profesional (usabilidad, jerarquía visual, accesibilidad, propuestas de mejora)
  - `/security` — auditoría de seguridad OWASP (inyección, auth, secrets, control de acceso)
  - `/tests` — generación de tests unitarios e integración con el framework del proyecto
  - `/explain` — explicación didáctica de código con analogías y ejemplos
  - `/refactor` — refactorización manteniendo comportamiento (legibilidad, SRP, tipos)
  - `/pr-review` — code review de PR con veredicto final
- **`/skills`** — lista todas las skills instaladas con su descripción.
- **Autocompletado de skills:** al escribir `/` aparecen también los nombres de las skills disponibles junto a los comandos built-in.
- **Cómo crear una skill propia:** crea `~/.squeezr-code/commands/mi-skill.md` con el prompt que quieras. Usa `$ARGS` para inyectar los argumentos. Ejemplo: `/mi-skill @src/component.tsx` → `$ARGS = "@src/component.tsx"`.

## [0.84.45] - 2026-04-19

### Changed
- **Help overlay — login:** separado en su propia línea mostrando los tres proveedores: `/login anthropic  /login openai  /login google`.

## [0.84.44] - 2026-04-19

### Fixed
- **`/help` borraba el output:** al añadir las líneas de ayuda al stream de output, el banner y los mensajes anteriores eran empujados fuera de la ventana visible. Ahora `/help` abre un **overlay** con borde encima del status bar (igual que el model picker). El output queda intacto. Esc / Enter / q cierra el overlay.

## [0.84.43] - 2026-04-19

### Changed
- **`/help` compacto en el Ink REPL:** el help original de 50+ líneas no cabía en pantalla y el scroll nativo no funciona dentro de Ink. Reemplazado por una tarjeta de referencia rápida agrupada por categoría que cabe en cualquier terminal de tamaño estándar. Los comandos avanzados remiten a `sq --classic`.

## [0.84.42] - 2026-04-19

### Fixed
- **Comandos slash no funcionaban o daban respuestas vacías en el Ink REPL:**
  - `/cost`, `/context`, `/status`, `/history`, `/usage`, `/export`, `/env`, `/perf`, `/feedback`, `/release-notes` — ya funcionaban pero no tenían datos reales (costByModel, history, systemPrompt hardcodeados a vacío). Ahora conectados al agente real.
  - `/repeat` — reenvía el último mensaje del usuario.
  - `/cancel` — vacía la cola de mensajes pendientes.
  - `/tasklist` y `/tasklist clean` — muestra/limpia la lista de tareas.
  - `/router on|off|show` — muestra/cambia el estado del router.
  - Comandos no disponibles en el Ink REPL (mcp, resume, paste, fork, committee, etc.) muestran un mensaje claro indicando usar `sq --classic`.
- **Lista de sugerencias de autocompletado depurada:** solo aparecen los comandos que realmente funcionan en el Ink REPL.

## [0.84.41] - 2026-04-19

### Changed
- **`/model` con picker interactivo:** al escribir `/model` aparece un picker encima del status con 8 modelos curados (opus 4.7, sonnet 4.6, haiku 4.5, GPT-5.4, GPT-5.4-mini, Codex 5.3, Gemini 2.5 Pro/Flash). Navegar con ↑↓, Enter para seleccionar y fijar como modelo activo, Esc para cancelar. Eliminada la lista gigante de todos los aliases.

## [0.84.40] - 2026-04-19

### Fixed
- **`/model` y otros comandos con acción no se ejecutaban:** comandos que devuelven una `action` (pick-model, compact, login) eran ignorados en el Ink REPL. `/model` sin args ahora muestra la lista de aliases disponibles. `/compact` compacta el historial inline. `/login` indica cómo autenticarse.
- **No se podía hacer scroll en outputs largos:** añadido scroll manual con `Ctrl+U` (subir) y `Ctrl+D` (bajar). El separador superior muestra el hint cuando no estás en modo live. Al enviar un mensaje nuevo, vuelve automáticamente al fondo.

## [0.84.39] - 2026-04-19

### Fixed
- **Ctrl+T y Ctrl+O escribían `t`/`o` en el input:** `ink-text-input` y `useInput` son handlers independientes — cuando nuestro handler capturaba Ctrl+T, `ink-text-input` igualmente insertaba el carácter. Eliminado `ink-text-input` y reemplazado por input manual completo con cursor `▌` visible. Ctrl+W (borrar palabra), Ctrl+A (limpiar), backspace, y autocompletado de sugerencias funcionan sin conflictos.

## [0.84.38] - 2026-04-19

### Fixed
- **Cursor no va al final tras autocompletar con Tab:** `ink-text-input` mantiene su cursor interno aunque cambie el `value` externamente. Al pulsar Tab para completar una sugerencia, se fuerza un re-mount del componente (`key` counter) para que el cursor quede al final del texto completado.

## [0.84.37] - 2026-04-19

### Fixed
- **`@alias` no cambiaba el modelo en el Ink REPL:** el prompt `@5.4-mini hola` enviaba todo el texto al agente sin extraer el override. Ahora se parsea igual que en el REPL clásico: `@alias texto` → modelo=alias, prompt=texto. El `authStatus` real (con openai/google según auth) se pasa al router en vez del hardcodeado solo a Anthropic.

## [0.84.36] - 2026-04-19

### Added
- **Autocompletado de `/` y `@` en el Ink REPL:** al escribir `/` aparece una lista de comandos disponibles debajo del input. Al escribir `@` aparecen los alias de modelos (sonnet, opus, haiku, etc.). Navegar con ↑↓, completar con Tab, cerrar con Esc.

## [0.84.35] - 2026-04-19

### Changed
- **Barra de contexto con colores de alerta:** azul (< 70%) → naranja (≥ 70%) → rojo (100%).

## [0.84.34] - 2026-04-19

### Fixed
- **Banner de bienvenida ausente en el Ink REPL:** el logo ASCII de Squeezr, versión, auth status, cwd y tip ya aparecen al arrancar `sq`. Al hacer `--continue` también se muestra la info de sesión resumida debajo del banner.

## [0.84.33] - 2026-04-19

### Fixed
- **Espacio vacío (parte 2):** el `height={rows}` en el contenedor externo seguía forzando a Ink a reservar la altura completa del terminal aunque no hubiera contenido. Eliminada toda altura fija del layout — Ink re-renderiza desde el cursor hacia abajo, así que el status+input aparecen justo debajo del último mensaje sin líneas en blanco.

## [0.84.32] - 2026-04-19

### Fixed
- **Espacio vacío gigante en el output:** el `<Box height={outputHeight}>` reservaba todas las filas aunque solo hubiera 1 línea de contenido. Reemplazado por `<Box flexGrow={1}>` con `height={rows}` en el contenedor externo. El status+input quedan pegados al fondo sin líneas en blanco.

## [0.84.31] - 2026-04-19

### Added
- **`--continue` en el Ink REPL:** `sq --continue` ahora arranca el Ink REPL (input pinned) en lugar del classic REPL. Auto-compact si el historial supera 100KB al cargar.
- **Cursor visible en el input:** el prompt `❯` muestra un cursor `▌` que indica dónde se escribe.

### Changed
- `sq --continue` / `sq resume` usan el Ink REPL por defecto.

## [0.84.30] - 2026-04-19

### Fixed
- **123k tokens en resume (parte 2):** el límite de tool results en historial bajado de 20KB a 5KB. Auto-compact ahora se dispara al cargar la sesión si el historial supera 100KB — antes de que el usuario envíe su primer mensaje. El usuario ve `▸ session history is large — compacting before start…` y el historial queda comprimido antes del primer turno.

## [0.84.29] - 2026-04-19

### Fixed
- **125k tokens en "hola" con `--continue`:** al reanudar una sesión, el historial guardado incluía tool results completos (ficheros leídos, bash outputs) de turnos anteriores sin truncar. Ahora `setConversationHistory()` aplica el mismo límite de 20KB por tool result al cargar el historial, igual que al guardarlo. Sesiones antiguas quedan saneadas automáticamente en la primera reanudación.
- **Umbral de auto-compact bajado de 95% a 75%:** el historial se compactaba demasiado tarde. Con 75% el auto-compact actúa antes de que el contexto se sature, evitando el efecto "100% a la primera consulta" tras sesiones largas.

## [0.84.28] - 2026-04-19

### Fixed — auditoría de tokens (parte 3)
- **Task panel polling eliminado:** el `setInterval` de 2s que actualizaba el panel de tareas aunque no hubiera cambios ha sido eliminado. El panel ahora solo se actualiza tras eventos `TaskCreate` / `TaskUpdate`, con debounce de 100ms para evitar cascadas de re-renders.
- **Cache de git branch (10s TTL):** `getGitBranch()` re-caminaba el árbol de directorios en cada turno. Ahora cachea el resultado 10 segundos.
- **Cache de project memory con mtime:** `loadProjectMemory()` re-leía los ficheros SQUEEZR.md / CLAUDE.md en cada turno y añadía hasta 30KB al system prompt sin comprobar si habían cambiado. Ahora cachea el contenido y solo recarga si algún fichero tiene un mtime distinto.

## [0.84.27] - 2026-04-19

### Fixed — consumo excesivo de tokens (parte 2)
- **Auto-compact en el Ink REPL:** el REPL de Ink no tenía auto-compact — el historial crecía sin límite y cada turno re-enviaba todo a la API. Ahora cuando el contexto supera el `auto_threshold` (95% por defecto), compacta automáticamente igual que el REPL clásico.
- **Tool results truncados en el historial:** los resultados de Read/Bash/Grep se re-envían en cada turno siguiente. Si un fichero leído pesaba 100KB, se mandaba 100KB adicionales en cada turno posterior. Ahora se truncan a 20KB en el historial (el modelo ve el resultado completo en el turno que lo ejecutó, solo el historial queda truncado).

## [0.84.26] - 2026-04-19

### Fixed
- **Consumo excesivo de tokens:** tres causas identificadas y corregidas:
  1. **Recaps desactivados por defecto** — el recap LLM (llamada extra a la API al final de cada turno largo) estaba ON por defecto. Ahora es OFF. Se puede activar con `[display] recaps = true` en `sq.toml`.
  2. **Umbral de recaps subido** — cuando están ON, el umbral pasa de ">60s + 2 tools" a ">5 min + 3 tools" (o >10 min en cualquier caso), evitando recaps en turnos moderados.
  3. **Router no conectado al Ink REPL** — el REPL de Ink siempre usaba el modelo por defecto (opus) aunque el prompt fuera trivial. Ahora aplica el mismo auto-router que el REPL clásico: prompts cortos/simples → haiku, el resto → sonnet, solo keywords complejos → opus.

## [0.84.25] - 2026-04-19

### Added
- **Panel de tareas (Ctrl+T):** las tareas ya no se mezclan en el historial de conversación. Aparecen en un panel dedicado entre el output y el status bar, siempre actualizado (live snapshot tras TaskCreate/TaskUpdate + polling cada 2s). El panel ajusta la altura del output automáticamente para que todo quepa. Ctrl+T lo muestra u oculta.
- **Thinking collapse con resumen (Ctrl+O):** en modo colapsado, los bloques de thinking se sustituyen por una línea `▸ thinking (N lines) · Ctrl+O to expand` en vez de desaparecer sin dejar rastro. Ctrl+O de nuevo expande el bloque completo.

## [0.84.24] - 2026-04-19

### Fixed
- **Ctrl+T y Ctrl+O no hacían nada:** añadidos los handlers en `useInput`. Ctrl+T oculta/muestra las líneas `task_item` del output. Ctrl+O oculta/muestra los bloques `thinking`. La mode line ahora indica el estado actual (`expand`/`collapse`) de cada toggle.
- **Permission picker ilegible:** el picker nativo de readline rompía el layout de Ink escribiendo directamente a stdout. Reemplazado por un picker React nativo: cuando Squeezr necesita permiso para ejecutar una tool, aparece un recuadro naranja encima del status bar con las opciones 1/Y/2/3/N. Los números y letras resuelven la promesa sin salir del flujo de Ink.

## [0.84.23] - 2026-04-19

### Changed
- **Paleta de colores:** eliminados los verdes y cian neon y el magenta. Nueva paleta con tonos apagados: verde musgo `#6aaa6a`, azul acero `#7a9ec2`, naranja tostado `#c8a050`, cadet blue `#5f9ea0`. El fondo del diff verde pasa de `#003300` a `#1a4a1a` para mayor contraste con el texto blanco.

## [0.84.22] - 2026-04-19

### Fixed
- **Líneas largas sin `│` en continuación:** cuando el texto de una respuesta superaba el ancho del terminal, Ink hacía wrap automático pero las líneas de continuación no tenían el `│` de la izquierda. Ahora se aplica word-wrap manual al crear cada `OutputLine`, de modo que cada fragmento visual es una línea independiente con su propio prefijo `│`.

## [0.84.21] - 2026-04-19

### Added
- **Esc para limpiar input:** primer Esc mientras escribes muestra el hint `Esc again to clear` al lado del cursor. Segundo Esc dentro de 1.5s borra el input completamente. Cualquier otra tecla cancela el hint y sigue escribiendo con normalidad.

## [0.84.20] - 2026-04-19

### Added
- **Ink REPL (pin input bottom):** rewrite del REPL usando Ink (React para terminales). El input `❯` siempre está visible en la última fila del terminal, nunca desaparece durante el procesamiento. Incluye streaming chunk a chunk, cola de mensajes mientras trabaja, historial ↑↓, Shift+Tab para ciclar modo, Ctrl+C para abortar, y slash commands.
- **`--classic` flag:** el REPL de readline clásico sigue disponible con `sq --classic` para quien lo prefiera.

## [0.84.19] - 2026-04-19

### Fixed
- **Texto del diff ilegible:** las líneas `-` y `+` usaban texto rojo/verde sobre fondo rojo/verde oscuro, lo que hacía el texto casi invisible. Ahora se usa texto blanco (`\x1b[97m`) sobre el fondo de color — igual que hace Claude Code.

## [0.84.18] - 2026-04-19

### Fixed
- **Status bar repetido durante el procesamiento:** el `rl.prompt(true)` añadido en 0.84.16 para re-mostrar el prompt tras cada tool imprimía el bloque de status completo (separadores + modelo + modo) en bucle, borrando el output del agente. Revertido — la línea de input sigue desapareciendo durante el processing pero el output ya no se corrompe.

## [0.84.17] - 2026-04-19

### Fixed
- **Recap en blanco en vez de gris:** el texto del `※ recap:` se mostraba en color normal (blanco) porque el `${RESET}` cortaba el `DIM` antes del texto. Ahora todo el recap, incluido el cuerpo, sale en gris tenue igual que Claude Code.

## [0.84.16] - 2026-04-19

### Fixed
- **Prompt de input desaparece durante el procesamiento:** el `❯` se redibuja tras cada tool ejecutada (`tool_result`), de modo que el usuario siempre ve dónde puede escribir. Los mensajes escritos mientras Squeezr trabaja se encolan y se procesan al terminar el turno actual.
- **Task list solo visible al final del turno:** ahora se muestra el checklist actualizado inmediatamente tras cada `TaskCreate` y `TaskUpdate`, sin esperar al `╰──` final. También se eliminaron los emojis del encabezado de la lista.
- **Edit/Write sin diff:** al ejecutar `Edit` o `Write`, se muestra el diff real al estilo Claude Code — líneas eliminadas con fondo rojo y `-`, líneas añadidas con fondo verde y `+`. Limitado a 40 líneas para no inundar el terminal.

## [0.84.15] - 2026-04-19

### Fixed
- **Mensajes de usuario largos truncados y sin fondo:** el bloque `│ you` cortaba el mensaje a 200 caracteres y lo pintaba en una sola línea (el fondo gris no cubría el desbordamiento). Ahora hace word-wrap al ancho real del terminal y pinta cada línea con fondo completo.
- **OAuth login con Ctrl+V cancelado:** el flow de `sq login anthropic/openai/google` cancelaba inmediatamente al pegar el código con Ctrl+V. Los terminales modernos envuelven el paste con secuencias de bracketed paste mode (`\x1b[200~...\x1b[201~`); el `\x1b` inicial se interpretaba como ESC y abortaba. Ahora se eliminan esas secuencias antes de procesar el input.
- **Identidad y estilo del agente:** el system prompt ahora identifica al agente como **Squeezr** (no "sq") y añade reglas de estilo estrictas: sin emojis, sin bullet points decorativos, respuestas directas y concisas al estilo de un ingeniero senior, sin frases de relleno ni listas de capacidades no solicitadas.

## [0.84.14] - 2026-04-17

### Added — Test suite
- **434 tests en 36 ficheros** bajo `test/`, corriendo con **vitest**. `npm test` (run), `npm run test:watch` (dev), `npm run test:coverage` (v8 coverage report).

- **Coverage actual:** ~24% overall (1423/5947 líneas) — **bajo en total porque no se testean los paths interactivos** (readline, raw mode, TTY pickers, OAuth flows, MCP stdio, interactive ink-app). Sin embargo:

  **Modules con >80% de cobertura (lógica pura):**
  - `markdown` — 97% (tables, inline, lists, code fences, all the regex)
  - `tasks` — 96%
  - `undo` — 95%
  - `custom-commands` — 97%
  - `error-format` — 92%
  - `web` — 91%
  - `monitor` — 84%
  - `system` — 81% (buildSystemPrompt + memory loading)
  - `session` — 82% (CRUD + prune)
  - `squads` — 82%
  - `cron` — 79%
  - `redact` — alta
  - `inline-image`, `discover`, `clipboard-image` (testable surface) — >87%

- **P1 cubierto (lógica pura determinista):** redact, audit, update-check, session, markdown, squads, mode, file-mentions, error-format, commands, cron, rules, undo, perf, tasks, agent helpers (classifyPromptForRouter, detectThinkingBudget, estimateCost, shortModelName), system, retry, config.

- **P2 parcial (con mocks):** web, monitor, worktree, clipboard-image, custom-commands, mcp/discover. Los adapters de API (anthropic/openai/google streaming) quedan como integration pendiente.

- **P3 e2e:** tests básicos de CLI `sq --help` / `sq --version` en `test/e2e/`.

### Bugs/smells descubiertos mientras se escribían los tests (no arreglados aún — task #138)
1. `web.ts htmlToMarkdown` regex de bold/italic captura `<body>` como si fuera `<b>`. Produce garbage si el HTML trae body.
2. `agent/system.ts findGitHead` walks upwards sin límite — si estás en un tmp dir bajo un parent git repo, coge el HEAD del padre.
3. `repl/file-mentions.ts` regex rechaza `@dir/` (directorio sin fichero). Solo dispara con `@./dir` o absoluto.
4. `tools/tasks.ts taskUpdate` no valida que `status` sea un enum válido — pasa-through `as TaskStatus`.
5. `tools/cron.ts compileCron` tiene una rama muerta (`if (val >= max) return false`) inalcanzable.
6. `state/redact.ts google-api` regex requiere exactamente 35 chars post `AIza` (comportamiento correcto, pero fácil de miscontar al escribir fixtures).

### Pendiente integración (task #139)
- OAuth flows de los 3 providers (requieren fixtures HTTP grabados)
- MCP stdio con stub server JSON-RPC
- Interactive pickers con node-pty
- Streaming adapters (cache_control injection, thinking budget, multimodal, cached_tokens)

## [0.83.14] - 2026-04-17

### Added — Phase 1 of ink rewrite
- **`sq --ink`** flag para probar el nuevo REPL con **ink** (React for terminals). PoC Phase 1: pin input bottom de verdad, output que scrollea arriba, status/mode/separadores siempre visibles aunque la IA esté respondiendo. Por qué ink:
  - ink tiene su propio render loop → garantiza pin input bottom sin luchar con `console.log` directos, banner ASCII, pickers y otros paths que antes rompían el layout con DECSTBM.
  - Layout declarativo con `<Box>` y `<Text>` — flex grow para el área de output, pinned footer para input.
  - `useInput` hook gestiona keystrokes sin pelearse con readline.

- **Dependencias nuevas**: `ink`, `react`, `@types/react`. TS config actualizado con `jsx: react` + `jsxFactory: React.createElement`.

- **Scope de Phase 1** (lo que funciona hoy con `sq --ink`):
  - Pin input bottom real. Output scrollea, prompt fijo.
  - Submit con Enter → manda al agent → respuesta completa aparece.
  - Status line (proyecto · ctx% · $cost · modelo).
  - Mode line con hints Ctrl+O / Ctrl+T.
  - Separadores `─` edge-to-edge.
  - Ctrl+C sale.

- **Pendiente — Phase 2** (streaming, tools, markdown, tablas, thinking, cancel, queue).
- **Pendiente — Phase 3** (pickers: model, mcp, session, permission, onboarding, login flow).

  El REPL clásico sigue siendo default (sin flag) hasta que ink esté al 100%.

## [0.82.14] - 2026-04-17

### Fixed
- **Revertido `pin_input_bottom` a OFF por default**. El banner ASCII salía intercalado con el output, los wraps del scroll region rompían la tabla de respuesta, y el mensaje `│ you` se veía mezclado con el resto. Causa raíz: pin_input_bottom requiere que TODO write a stdout pase por `screen.writeOutput` (que posiciona el cursor dentro del scroll region antes de escribir), pero muchos paths escapan:
  - `renderWelcomeFull` usa `console.log` directo → banner rota layout.
  - El erase del prompt multi-línea (`\x1b[6A\r\x1b[J`) asume modo inline, no pin.
  - Readline echo escribe en el prompt row sin pasar por screen.
  - Streaming del renderer tiene un wrapper `w()` pero la coordinación de cursor es frágil.

  Hacerlo bien requiere refactor completo con **ink** (React for terminals) — task #94 sigue pendiente.

  Mientras tanto: pin = OFF, prompt aparece inline al final de cada turno (como antes). Quien quiera probar el modo experimental puede poner `[display] pin_input_bottom = true` en `~/.squeezr-code/config.toml`.

## [0.82.13] - 2026-04-17

### Added
- **`pin_input_bottom = true` por default**. El bloque del prompt (topSep + status + mode + botSep + `❯` input) queda **fijo al fondo del terminal** usando scroll region DECSTBM. El output del agente scrollea arriba en la región (rows 1..H-5) sin tocar las 5 filas pinned. Mientras la IA está respondiendo, tu input bar se mantiene SIEMPRE visible abajo en la misma posición.

  Layout:
  ```
  row 1    ┐
  row 2    │ ← scroll region del output (streaming, tools, tablas, etc.)
  ...      │
  row H-5  ┘
  row H-4    ──────────────────────────────────── ← topSep
  row H-3    project · 4% 5h · $0.01 · opus 4.7  ← status
  row H-2      ↳ accept-edits · shift+tab …       ← mode
  row H-1    ──────────────────────────────────── ← botSep
  row H      ❯ _                                  ← prompt (readline)
  ```

  `INPUT_ROWS = 5` en `screen.ts`; `topSepRow()` / `botSepRow()` como filas nuevas; `drawInputArea()` pinta las 4 filas altas (topSep, status, mode, botSep) con DECSC/DECRC para no mover el cursor del usuario. Compatible con resize del terminal (se recalcula al vuelo).

  Para volver al modo inline (prompt al final del output de cada turno como antes), pon `[display] pin_input_bottom = false` en `sq.toml` o `~/.squeezr-code/config.toml`.

## [0.81.13] - 2026-04-17

UI polish — 4 features visuales.

### Added
- **Markdown tables con alineación real** — cuando el modelo streamea una tabla `| a | b | c |` línea a línea, sq la buffer-ea, calcula anchos máximos por columna, y al ver una línea no-tabla (o al final del turno) la pinta con bordes bonitos `┌┬┐ / ├┼┤ / └┴┘`. Soporta alineación de la línea separadora `:---`, `:---:`, `---:`. Primera row en bold si hay separador (header). Las cells mantienen su markdown inline (bold/code/links).

- **Líneas `─` arriba y abajo del input** — el área del prompt (status + mode) queda envuelta por dos separators edge-to-edge al ancho del terminal. Aísla visualmente el prompt del output de la respuesta, estilo Claude Code:
  ```
  ──────────────────────────────────────
  project/branch · 4% 5h · $0.01 · opus 4.7
    ↳ accept-edits · shift+tab   Ctrl+O expand thinking · Ctrl+T collapse tasks
  ──────────────────────────────────────
  ❯ _
  ```
  El erase-del-prompt al Enter se ajustó de 4 a **6 filas** para cubrir las 2 nuevas.

- **Banner ASCII variants** — `display.banner_style` en `sq.toml` / config.toml: `big` (default, el SQUEEZR grande), `compact` (una línea `▀█▀ SQUEEZR · CODE`), `slant` (ASCII slanted 5 líneas).

- **Custom prompt char** — `display.prompt_char` en config. Default `❯`. Puedes poner `▸`, `➜`, `$`, `>`, `λ`, lo que quieras como símbolo del cursor en el input.

## [0.77.13] - 2026-04-17

### Changed
- **Full English UI** — 174 user-facing strings translated from Spanish to English across 15 files: `/help` listing, slash command outputs (`/cost`, `/sessions`, `/redact`, `/airplane`, `/sticky`, `/squad`, `/dispatch`, `/tasklist`, `/library`, `/snippet`, `/env`, `/perf`, `/summary`, `/cancel`, `/gh`, `/clean`, `/router`, `/committee`, `/style`, `/review`, `/undo`, `/resume`, `/fork`, `/repeat`, `/search`, `/template`, `/paste`), error messages (`error-format.ts`), onboarding wizard, permission picker labels, pickers (session, mcp, model), agent abort message, tool return strings (executor, worktree, monitor), and renderer spinner labels / formatters.

  Comments and JSDoc left in Spanish (internal, not user-facing). Variable names, config keys, tool names unchanged. System prompts that go to the LLM (`CLAUDE_CODE_PREAMBLE`, etc.) stay as-is (already English).

  Build clean after every file edit.

## [0.76.13] - 2026-04-17

### Added
- **Hints de Ctrl+O / Ctrl+T en la mode line**. La línea `↳ accept-edits · shift+tab · …` ahora muestra a la derecha los bindings de Ctrl+O y Ctrl+T con el **verbo que cambia según el estado actual** (estilo Claude Code):
  ```
  ↳ accept-edits · shift+tab    Ctrl+O expand thinking · Ctrl+T expand tasks
  ```
  Tras pulsar Ctrl+O:
  ```
  ↳ accept-edits · shift+tab    Ctrl+O collapse thinking · Ctrl+T expand tasks
  ```
  `renderModeLine` acepta un segundo param `hints = { thinkingExpanded, tasksCollapsed }` y el renderer lo pasa con el estado actual. En pin mode el mode line se re-dibuja al instante tras cada toggle; en inline mode se actualiza en el siguiente prompt.

## [0.75.13] - 2026-04-17

### Fixed
- **Ctrl+C NO interrumpía el turno** — v0.75.11 añadió `rl.pause()` durante el streaming para evitar corrupción de output al teclear. Pero `rl.pause()` hace que el byte `\x03` (Ctrl+C) se quede buffered en stdin sin ser procesado por el SIGINT handler de readline → el turno seguía hasta terminar y solo al final rl.resume() procesaba el byte buffered, demasiado tarde.

  Fix: **quitado `rl.pause()`** — readline sigue activo durante el streaming, `rl.on('SIGINT')` captura Ctrl+C al instante y llama a `agent.abortCurrent()`. El check `if (this.aborted) break` al tope del for-await del agent (v0.75.12) corta el stream en el siguiente chunk.

  Trade-off aceptado: si el usuario teclea mientras la IA responde, readline redibuja el prompt mid-output (los status bars aparecen intercalados). Esto es limitación conocida de readline + stdout compartido. Solo se arregla bien con rewrite a ink (v0.94+). Prioridad: Ctrl+C funciona SIEMPRE.

## [0.75.12] - 2026-04-17

### Fixed
- **Ctrl+C no paraba el output al instante** — el modelo seguía "terminando de escribir lo que iba a decir". Causa: aunque `adapter.close()` cancela el HTTP reader, los chunks que ya estaban **buffered en el for-await** seguían procesándose y el renderer los pintaba. Fix: check de `this.aborted` al **tope de cada iteración** del for-await + `break` si está activo. Resultado: pulsas Ctrl+C → ningún chunk más se yieldea al renderer → el texto para de aparecer AL MILISEGUNDO.

  Extra: si había tools parallel-safe pendientes (`Task`/`Read`/etc.), al abortar se **descartan** (ya no se drenan con flushPending). Los promises siguen vivos en background pero sus resultados se tiran. En el próximo turno parten de cero.

## [0.75.11] - 2026-04-17

### Fixed
- **Ctrl+O rompía el output cuando se pulsaba durante streaming**. El handler escribía `↳ thinking EXPANDED` a stdout en medio del texto que el modelo estaba tecleando, lo que intercalaba con el render → status bar aparecía dentro del output N veces y la respuesta parecía duplicada/mezclada. Fix: el toggle Ctrl+O / Ctrl+T ahora es **silencioso** — aplica el flag al instante (afecta al próximo bloque thinking o al próximo turno con tasks) sin escribir nada a stdout. Si quieres ver el estado actual: `/style thinking show`.

- **Output corrupto al teclear mientras la IA respondía**. Readline redibujaba el prompt (status bar + mode line) en cada keystroke del usuario, intercalándose con el streaming → status bars apiladas dentro del texto de la respuesta. Fix: `rl.pause()` al empezar el turno + `rl.resume()` al terminar. Se pierde la feature de "encolar próximo mensaje mientras la IA piensa" pero el output queda 100% limpio. Arquitectura de split input/output genuina requiere un rewrite con ink — para la versión actual es el trade-off correcto.

- **"Interrupted by user" no aparecía al abortar con Ctrl+C**. Cuando `adapter.close()` cancela el reader del stream, el for-await termina silenciosamente **sin lanzar excepción** → el catch branch nunca disparaba el error event. Fix: tras el stream-end también chequeamos `if (this.aborted)` y emitimos el evento. Ahora al Ctrl+C ves el bloque gris `⏸ interrupted by user` debajo del último output como en Claude Code.

## [0.75.8] - 2026-04-17

### Added
- **"Interrupted by user" con fondo gris** cuando abortas un turno con Ctrl+C (o Esc) mientras el modelo está respondiendo / ejecutando tools. Antes salía un error rojo `✗ Cancelado por el usuario (Esc)` que parecía un fallo de verdad. Ahora sale debajo del último output como un bloque gris corto `⏸ interrupted by user` (mismo BG `\x1b[48;5;236m` que usamos para el mensaje del user), visualmente consistente con el resto del chat.

  Renderer detecta el error text con regex `/cancelado|interrupted|abort/i` y cambia el estilo en lugar de pintarlo rojo. Otros errores (API, auth, etc.) siguen en rojo como antes.

## [0.74.8] - 2026-04-17

### Added
- **Ctrl+O toggle thinking** (como Claude Code) — alterna entre ver el razonamiento interno del modelo expandido (línea a línea con `✻`) o colapsado a un summary (`✻ razonamiento colapsado · N líneas`). Banner `↳ thinking EXPANDED/COLLAPSED` al toggle. Funciona sin salir del prompt, mientras el modelo está pensando o después.
- **Ctrl+T toggle tasklist** — la lista de tasks tras cada turno (cuando el agente usa TaskCreate/TaskUpdate) ahora tiene dos modos:
  - **Expanded** (default): `📋 Tasks (N) · Ctrl+T collapse` seguido de la lista completa con iconos `○/⋯/✓` y tachado en completed.
  - **Collapsed**: una línea `📋 N tasks — 3 done, 1 active, 2 pending · Ctrl+T expand`.

  Exactamente como Claude Code.
- **`/tasklist`** — muestra TODAS las tasks de la sesión (pending + active + completed) fuera del flow post-turno. Útil para ver el histórico completo sin esperar al próximo turno.
- **`/tasklist clean`** — borra todas las tasks de la sesión (reset).

### Fixed
- **Status bar mostraba `0%` cuando el uso real era >0 pero <0.5%** (`Math.round(0.3) → 0`). Ahora: si el valor redondea a 0 pero no es exactamente cero, mostramos 1 decimal → `0.3% 5h` en lugar de `0% 5h`. Evita el "llevo 3 turnos con opus y dice que estoy al 0%".

## [0.70.7] - 2026-04-17

### Added
- **`/dispatch`** — multi-agent ad-hoc con sintaxis simple. Escribes un cuerpo multi-línea (usa `\` continuation) con `@modelo: prompt` por línea, y sq dispara todos los agentes **en paralelo** con sus respectivos providers:
  ```
  /dispatch \
  @opus: implementa logout OAuth con refresh token \
  @gpt-5-codex: revisa src/auth.ts buscando bugs \
  @gemini-pro: sugiere alternativas al flujo actual
  ```
  Muestra cada resultado en bloque separado con header (modelo + timing + role). Errores aislados via Promise.allSettled.

- **Squads** — plantillas persistentes de multi-agent en `~/.squeezr-code/squads.json`. Vienen 3 pre-instalados:
  - **`opinions`** (parallel) — opus + gpt-5 + gemini-pro respondiendo la misma pregunta. Para decisiones donde quieres comparar criterios.
  - **`pr-review`** (sequential) — opus implementa → gpt-5-codex revisa su implementación. `{{result_0}}` inyecta la salida del paso 1 en el prompt del paso 2.
  - **`build-and-test`** (sequential) — sonnet escribe código → haiku escribe tests del código.

  Uso: `/squad opinions Redux vs Zustand`, `/squad pr-review "implementa logout OAuth"`. `/squad list` ver disponibles.

  **Crear tu propio squad** editas `~/.squeezr-code/squads.json`:
  ```json
  {
    "my-squad": {
      "mode": "parallel",
      "agents": [
        { "model": "opus", "role": "arq", "prompt": "Propón arquitectura: {{task}}" },
        { "model": "gpt-5", "role": "crit", "prompt": "Lista objeciones: {{task}}" }
      ]
    }
  }
  ```
  Placeholders soportados: `{{task}}` (lo que pases al squad), `{{result_N}}` (salida del agente N en modo sequential), `{{result_last}}`.

## [0.68.7] - 2026-04-17

Concurrencia real.

### Added
- **Tools en paralelo**. El agent ejecuta ahora tools `PARALLEL_SAFE` fire-and-forget, guarda la Promise, y al terminar el stream las drena con Promise.all. Batch automático cuando el modelo emite múltiples tool_uses en una respuesta:
  - **Parallel-safe** (corren concurrentes): `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Task`, `Monitor`, `BashOutput`, `KillShell`, `TaskList`, `TaskGet`.
  - **Sequential (barrera)**: `Write`, `Edit`, `NotebookEdit`, `Bash`, `AskUserQuestion`, `ExitPlanMode`, `Cron*`, `EnterWorktree`/`ExitWorktree`. Antes de ejecutarlas, el agent drena todas las pendientes.

  Resultado: el modelo puede pedir `Read(a.ts) + Read(b.ts) + Read(c.ts)` y las 3 lecturas ocurren a la vez. Igual con 5 Tasks, 10 WebFetches, etc. Errores de una no paran las demás (try/catch individual).

- **`Task` con override de modelo inline** — el tool Task acepta un param `model` opcional:
  ```
  Task(description="fast check", prompt="...", model="haiku")
  Task(description="deep analysis", prompt="...", model="opus")
  Task(description="alt perspective", prompt="...", model="gemini-pro")
  ```
  Los 3 corren **en paralelo** y cada uno usa su provider. Mezcla Claude + OpenAI + Google en el mismo turno. `model` inline gana sobre el `model:` frontmatter del `subagent_type` si hay ambos.

  **Casos de uso reales:**
  - "Para este problema, quiero la opinión de 3 modelos distintos" → 3 Tasks con distintos models.
  - "Busca en paralelo en estos 5 ficheros" → 5 Reads batched.
  - "Investiga estos 4 tickets de Jira + el docstring de estas funciones" → Tasks + Reads mezclados.

## [0.66.7] - 2026-04-17

Security + UI/UX — 6 features para B2B y usuarios pro.

### Added
- **`/redact on|off|status`** — enmascara secrets en **tu prompt antes** de mandar al modelo. Patterns: AWS access keys, GitHub tokens (ghp_/gho_/ghs_/ghr_/github_pat_), Anthropic (sk-ant-api0X-*), OpenAI (sk-proj-/sk-*), Google API keys (AIzaSy*), Slack (xox[bpr]-*), bearer tokens, JWTs, SSH private keys (bloque entero), y basic auth embedded en URLs. Reemplaza por `[REDACTED_*]` preservando el tipo. Cuenta cuántos redactó + resumen por tipo.
- **Secret scanner en tool outputs** — **default ON**. Antes de meter al contexto del modelo el resultado de `Read`, `Bash`, `BashOutput`, `WebFetch`, `WebSearch`, `Grep`, `Monitor`, aplica redaction. El modelo nunca ve secrets que aparezcan por accidente en ficheros o comandos. Opt-out con `[security] redact_tool_outputs = false`.
- **`/airplane on|off|status`** — local-only mode. Bloquea el turno antes de llamar a la API: "el prompt NO se envió al modelo. Quita airplane con /airplane off para continuar". Tools locales (Read, Grep, Bash sin red) siguen funcionando porque los ejecuta el agente PERO no hay agente ejecutando sin API — en la práctica pone sq en pausa segura. Útil para cerrar portátil sin terminar el turno a mitad.
- **Inline images (iTerm2 / Kitty / WezTerm)** — cuando tu terminal soporta graphics protocol, la imagen pegada se **renderiza en el chat** además del token `[Image #1]`. Detección automática via `TERM_PROGRAM` (iTerm.app, WezTerm) o `TERM=xterm-kitty`. iTerm2 usa OSC 1337; Kitty usa APC G chunked transmission. Windows Terminal y xterm plano no lo soportan — fallback al token como antes.
- **Sticky mentions (`@@path.ts`)** — si mencionas un fichero con doble @@, queda **"pegado"** para los siguientes turnos: sq lo re-inyecta automáticamente al inicio del prompt hasta que lo limpies. Comandos:
  - `/sticky` / `/sticky list` — ver activos
  - `/sticky clear` — vaciar
  - `/sticky add PATH` / `/sticky remove PATH` — manipular
- **Thinking blocks colapsados** — por defecto el razonamiento interno (`✻ ...`) ya NO se pinta línea a línea; se acumula y se muestra como `✻ razonamiento colapsado · N líneas / M chars`. Reduce el ruido de turnos largos con mucho thinking. Toggle con `/style thinking expanded` para ver todo, `/style thinking collapsed` para volver al default.

### Config
- Nueva sección `[security]` en `~/.squeezr-code/config.toml`:
  ```toml
  [security]
  redact_prompts = false       # opt-in
  redact_tool_outputs = true   # default ON
  airplane = false
  ```
  Los toggles de `/redact` y `/airplane` persisten aquí.

## [0.60.7] - 2026-04-17

### Fixed / Added
- **`/gh pr NUMBER` sin ambigüedad de repo**. Antes se entendía silenciosamente "del cwd", pero si arrancabas sq fuera de un repo git o el remote no era GitHub, el error de `gh` era poco claro. Ahora:
  - Soporta **`/gh pr 42 --repo owner/name`** para atacar un repo distinto al del cwd (útil para revisar PRs de otros proyectos sin cd-arse ahí).
  - Sin `--repo`, infiere del `origin` del cwd (mismo comportamiento que `gh pr view` directo).
  - Si no puede inferir ni le pasas `--repo`, mensaje explícito con las 2 opciones (cd al repo, o `--repo`) en lugar de un stderr críptico.

## [0.60.6] - 2026-04-17

Productividad + UI polish + integración GitHub.

### Added
- **`/snippet save NAME`** — guarda el último mensaje de assistant como snippet reusable en `~/.squeezr-code/snippets.json`. `/snippet insert NAME` lo reinyecta como prompt. `/snippet list` / `/snippet delete NAME`. Útil para "guarda esta respuesta perfecta y reusa el contenido en otra conversación".
- **`/env`** — volca las env vars que sq respeta (`SQ_MODEL`, `SQ_PERMISSIONS`, `SQ_PROXY_PORT`, `SQ_MCP_AUTO_IMPORT`, `SQ_DEBUG`, `SQ_VERBOSE`) + node version / platform / cwd. Debugging rápido de "¿por qué sq está usando ese modelo / no encuentra mi config?".
- **`/perf`** — tabla de performance por tool en la sesión actual: calls, total ms, avg ms, max ms, errors. Tracker in-memory incrementado en `executor.ts` envolviendo `executeInner`. Ordenado por tiempo total para ver qué tools están haciendo cuello de botella.
- **`/summary`** — reinyecta un prompt `"Resume en 5-8 bullets…"` como mensaje del usuario. El modelo lo responde con TL;DR de la sesión (decisiones, cambios, problemas abiertos) sin tener que escribirlo tú.
- **`/cancel`** — saca el último mensaje del `pendingQueue` si encolaste algo mientras la IA respondía y te arrepentiste.
- **`/library [name]`** — biblioteca de prompts pre-hechos hard-coded:
  - `review-pr` — review estilo PR del git diff actual
  - `explain` — explicación pedagógica de un fichero
  - `tests` — genera unit tests para lo último visto
  - `optimize` — busca oportunidades de optimización
  - `docs` — añade JSDoc/TSDoc a funciones exportadas
  - `refactor` — refactor paso a paso con justificación
  - `commit` — sugiere mensaje de commit del diff
  - `debug` — debugging sistemático con hipótesis ordenadas

  `/library` sin args lista los disponibles. `/library <name>` reinyecta el prompt.
- **`/gh pr NUMBER`** — integración con GitHub CLI. Ejecuta `gh pr view NUMBER --json` + `gh pr diff NUMBER` (via `execSync`, asume `gh` instalado) y construye un prompt de review con meta + diff (truncado a 80k chars). Si `gh` no está o el PR no existe, error claro. El modelo recibe título, autor, rama, descripción y diff en un solo turno.

## [0.53.6] - 2026-04-17

Pack de diferenciadores — los 6 features que Claude Code NO tiene.

### Added
- **`/cost explain`** — desglose didáctico de la factura: cuántos tokens input/output por modelo, qué % vino de cache (al 10%/25%/50% según provider), y cuánto DE VERDAD ahorraste con el prompt caching. Ayuda a entender por qué gastaste $X sin tener que saber los precios de memoria.
- **`/cost preview [prompt]`** — estima cuánto te costará el siguiente turno en **los 6 modelos disponibles** (opus/sonnet/haiku/gpt-5/codex/gemini-pro) dados el system + historial + prompt actual. Incluye el descuento del caching asumiendo que el prefijo ya está cacheado de turnos anteriores. Útil para decidir "¿lo paso a haiku antes de mandarlo?".
- **`/context tree`** — vista visual ASCII del contexto con barras proporcionales:
  ```
  Context breakdown  12,345 tok · 6% de 200,000
  System prompt  ███████░░░   2,100 tok
    ├─ Base instructions           1,200 tok
    ├─ Memoria (SQUEEZR.md)          800 tok
    └─ cwd + git                     100 tok
  Tool definitions ████████░░ ~3,500 tok (cached)
  History        █████████░░  5,500 tok (18 msg)
  ```
- **`/clean`** — menú interactivo para borrar ficheros temporales: `models-cache.json`, `update-check.json`, `.claude/worktrees/`, sesiones stub (sin mensajes). Confirmación por categoría, `all` para todo.
- **Auto-router** con `/router on|off|show` — clasifica cada prompt por heurística:
  - keywords complejos (`architect`, `refactor`, `debug`, `algorithm`, `think hard`, `ultrathink`) → `opus`
  - prompts cortos (<40 chars) o preguntas básicas (`what`, `how`, `qué`, `cómo`) → `haiku`
  - resto → `sonnet` (balance)

  Overrides con `@modelo` siempre pisan el router. Config persistida en `[router] enabled = true` en `~/.squeezr-code/config.toml`.

- **Committee mode** con `/committee <prompt>` — manda el mismo prompt a Opus + GPT-5 + Gemini Pro **en paralelo** (`Promise.allSettled`), imprime cada respuesta lado a lado truncada a 2000 chars. Para decisiones críticas donde quieres comparar criterios de 3 modelos antes de tomarlas. Requiere al menos 2 providers autenticados.

## [0.47.6] - 2026-04-17

Productividad — 4 features nuevos que agilizan el uso diario.

### Added
- **`/fork`** — clona la sesión actual en una sesión nueva con el historial copiado. Sigues en la original; la forked vive en disco como una sesión más (puedes entrar con `sq resume <id>` o `/resume`). Para explorar alternativas ("y si ahora le digo que use Redux en vez de Context") sin perder el flujo actual.
- **`/repeat`** — reenvía tu último mensaje tal cual. Útil cuando falló por auth expirada, rate limit, o timeout y quieres reintentar sin teclear de nuevo el prompt largo. Reemite un evento `'line'` al readline → pasa por el flow normal de expansión + envío.
- **`/search <texto>`** — regex case-insensitive sobre `messages` de TODAS las sesiones guardadas en `~/.squeezr-code/sessions/`. Primer hit por sesión con preview de 110 chars + id + antigüedad. "¿qué le pregunté hace tres semanas sobre webpack?" → `/search webpack`.
- **`/template save NAME "prompt con $1 $2"`** + **`/template use NAME arg1 arg2`** — templates de prompts parametrizados, persisten en `~/.squeezr-code/templates.json`. Placeholders `$1` … `$N` se reemplazan por los args del `use`. `/template list` ver todos, `/template delete NAME` borra.

## [0.43.6] - 2026-04-17

Tanda de **catch-up con Claude Code + Codex** — 6 features nuevos, empatan funcionalidad para que la decisión de usar sq no tropiece con "le falta X".

### Added
- **`/style default|concise|explanatory`** — output styles al estilo Claude Code. Inyecta una directiva extra en el system prompt según el modo elegido. `concise` corta el preamble y respuestas largas (mínimo viable); `explanatory` fuerza respuestas pedagógicas paso a paso. Se persiste en la sesión, no en disco — reset al reiniciar sq.
- **`/history [N]`** — muestra los últimos N turnos (default 20) de la sesión actual. Emparejamiento user → assistant, preview de 120 chars por entrada. Lee `agent.getConversationHistory()` sin tocar el historial.
- **Audit logs** — JSONL append-only en `~/.squeezr-code/audit.log` con cada tool ejecutada: `{ts, sid, cwd, tool, input, out_sha256, out_preview, error?}`. **Opt-in** via `[audit] enabled = true` en `~/.squeezr-code/config.toml`. Para compliance, debugging, y ventas B2B. Best-effort — errores de escritura no rompen la ejecución.
- **`Monitor` tool** — ejecuta un comando shell, filtra stdout+stderr por regex, devuelve líneas matched cuando el proceso termina o expira el timeout (default 60s, max 10min). Para builds, tests, tail de logs. Cuando el modelo quiere ver "solo los ERRORs de `npm run build`", llama `Monitor({ command: "npm run build", filter: "error|FAIL", timeout_ms: 120000 })`.
- **Cron scheduling** (`CronCreate` / `CronList` / `CronDelete`) — tools para que el agente programe prompts a ejecutarse en el futuro. Syntax estándar 5 fields `M H DoM Mon DoW` en timezone local. Parser propio sin dependencias (soporta `*`, `*/N`, `N`, `N-M`, `N,M,L`). Los jobs se disparan cuando el REPL está idle — `setCronFireHandler` inyecta el prompt como si el user lo tecleara. Recurrentes auto-expiran a 7 días; one-shots se borran tras fire.
- **Worktree tools** (`EnterWorktree` / `ExitWorktree`) — crea un git worktree bajo `.claude/worktrees/<name>/` con branch nueva, cambia el cwd del REPL al worktree. `ExitWorktree action=keep` sale preservando el worktree; `action=remove` lo borra + la branch (con chequeo de cambios sin commit, override con `discard_changes=true`). Solo un worktree activo a la vez.

### Tool count
Con este bump, sq tiene **22 tools built-in**: Read, Write, Edit, Bash, BashOutput, KillShell, Glob, Grep, WebFetch, WebSearch, TaskCreate, TaskList, TaskGet, TaskUpdate, NotebookEdit, AskUserQuestion, Task, ExitPlanMode, **Monitor**, **CronCreate**, **CronList**, **CronDelete**, **EnterWorktree**, **ExitWorktree** (+ MCP tools dinámicas).

## [0.37.6] - 2026-04-17

### Added
- **Ctrl+V para imagen ahora funciona de verdad** vía **bracketed paste mode** — la técnica que usan Claude Code, Gemini CLI y opencode. Flujo real:

  1. Al arrancar sq emite `\x1b[?2004h` por stdout → le dice al terminal "avísame cuando el user pegue algo envolviéndolo entre `\x1b[200~` y `\x1b[201~`".
  2. Aunque Windows Terminal intercepte Ctrl+V para su propio paste-text binding, **sí envía los marcadores de bracketed paste al proceso**. Eso es lo que nos da el evento "el usuario acaba de pulsar Ctrl+V".
  3. Cuando vemos `\x1b[200~` en stdin, disparamos `readClipboardImageAsync()` (no bloquea el event loop). Si el SO tiene imagen en el clipboard → insertamos `[Image #N]`. Si solo tiene texto → readline ya lo está metiendo por su lado, nosotros no hacemos nada.
  4. Al cerrar, emitimos `\x1b[?2004l` para devolver el terminal a su estado original.

  Confirmado investigando los PRs públicos de otros CLIs:
  - [google-gemini/gemini-cli#13645](https://github.com/google-gemini/gemini-cli/pull/13645) y [#13997](https://github.com/google-gemini/gemini-cli/pull/13997)
  - [anthropics/claude-code#12644](https://github.com/anthropics/claude-code/issues/12644)
  - [sst/opencode#3816](https://github.com/sst/opencode/issues/3816)

- **Quitado Ctrl+V del keypress fallback** para evitar doble inserción en terminales (Linux) donde Ctrl+V SÍ llega como keystroke raw además del bracketed paste. Alt+V y F2 se mantienen como backup explícito por si tu terminal no soporta bracketed paste (raro — Windows Terminal 1.12+, iTerm2 3.0+, GNOME Terminal 3.20+, Alacritty, kitty todos lo soportan).

### Removed
- **Background clipboard polling** (`setInterval` cada 1.2s). Ya no es necesario — con bracketed paste es event-driven, cero overhead cuando no pegas nada. Además el polling era la raíz del typing lag de la v0.36.5.

## [0.36.6] - 2026-04-17

### Fixed
- **Typing super lento / letras aparecían con retraso**. La v0.36.5 añadió un keypress trigger que llamaba a `readClipboardImage()` cada tecla (con debounce 400ms), pero esa función usa `execFileSync('powershell.exe', …)` que **bloquea el event loop** 50-200ms por llamada. Resultado: cada letra tecleada disparaba un spawn de PowerShell síncrono → lag visible al escribir.

  Fix: quitado el keypress trigger completamente. Creada `readClipboardImageAsync()` (usa `execFile` async, no bloquea) y el background poll ahora va cada 1.2s usando esa versión async. PowerShell corre en background, el typing queda fluido 100%.

  Resultado: sigue funcionando el auto-detect de imagen en clipboard cada 1.2s, pero sin tocar el teclado del usuario.

## [0.36.5] - 2026-04-17

### Fixed
- **Ctrl+V seguía "sin hacer nada" aunque el poll estuviera corriendo**, porque el intervalo era 1.5s y el usuario pulsaba Ctrl+V a los 200ms del recorte — sencillamente no había dado tiempo a un tick. Ahora:
  - Background poll cada **800ms** (antes 1500).
  - Además cada **keypress dispara un check inmediato** (debounced a 400ms mínimo entre triggers) — cualquier tecla que pulses tras el recorte, incluido el Ctrl+V que el terminal medio come pero algunos chars pueden llegar, dispara la detección instantánea.
  - Resultado: el `[Image #N]` aparece en ≤100ms tras presionar casi cualquier tecla, y en ≤800ms si no tocas nada.

## [0.36.4] - 2026-04-17

### Added
- **Clipboard watcher para que Ctrl+V "funcione" aunque el terminal lo intercepte**. Imposible anular la intercepción de Ctrl+V de Windows Terminal / iTerm2 desde el proceso hijo, así que polleamos el portapapeles cada 1.5s. Cuando detectamos una imagen NUEVA (hash de tamaño + primeros 64 chars del base64 cambia), auto-insertamos `[Image #N]` en el input. Para el usuario:

  1. Haces `Win+Shift+S` → recortas
  2. Pulsas `Ctrl+V` (o no pulsas nada, da igual)
  3. En ≤1.5s aparece `[Image #1]` en tu prompt + log `✓ [Image #1] detectada en portapapeles (N KB)`
  4. Sigues tecleando tu prompt y Enter

  Inicializamos el hash al arrancar con lo que haya ya en el clipboard → NO dispara inserción con imágenes antiguas. Solo las copiadas después de abrir sq. Pausa el polling durante turnos activos para no molestar.

## [0.35.4] - 2026-04-17

### Added
- **Doble Ctrl+C para salir** (estilo bash / Node REPL / Claude Code). Comportamiento:
  - **Turno en curso** + Ctrl+C → aborta el turno (no sale).
  - **Input con texto** + Ctrl+C → limpia la línea (no sale).
  - **Input vacío** + primer Ctrl+C → avisa `(pulsa Ctrl+C otra vez en 2s para salir)`.
  - Otro Ctrl+C **dentro de 2s** → cierra sq.
  - Cualquier otra tecla durante esos 2s **desarma** el exit pendiente.

  Evita cierres accidentales al pulsar Ctrl+C buscando cancelar un prompt que ya se había acabado.

## [0.34.4] - 2026-04-17

### Added
- **Alt+V y F2 para paste de imagen**. Ctrl+V no funciona en Windows Terminal / iTerm2 / la mayoría de terminales modernos porque esas apps interceptan Ctrl+V **antes** del proceso para pegar el texto del clipboard — cuando el clipboard solo tiene imagen (recorte de Windows, screenshot), la terminal pega cadena vacía y el keypress real nunca llega a Node. No hay forma de anular eso desde el proceso hijo. Solución: bindeamos también **Alt+V** (que Windows Terminal y iTerm no interceptan por defecto) y **F2** (universal — escape sequence `\x1bOQ` siempre pasa). Ctrl+V se mantiene como tercer binding por si el terminal no la come (algunos Linux).

  Mismo flow que antes: detecta imagen en clipboard, asigna número, inserta `[Image #N]` en el input, sigues tecleando el prompt. `/help` y `/paste` mencionan ambos atajos.

## [0.33.4] - 2026-04-17

### Changed
- **Ctrl+V y `/paste` ahora insertan `[Image #N]` como texto literal** en vez de auto-enviar el mensaje. Igual que Claude Code: pegas la imagen (Ctrl+V tras `Win+Shift+S`), ves `[Image #1]` aparecer en el input, sigues tecleando tu prompt (ej. "explica el error en [Image #1]"), y pulsas Enter cuando estés listo. Al enviar, sq parsea los `[Image #N]` del texto y adjunta las imágenes correspondientes — el modelo ve los tokens literales en el mensaje + los bloques image_base64, así que puede referenciar cada imagen por número ("mira la línea roja en [Image #2]").

  Counter global de sesión: puedes pegar 2 o 3 imágenes en el mismo turno (`[Image #1] [Image #2] compara estas`), y cada una se consume al enviarse (no re-aparece en turnos siguientes).

## [0.32.4] - 2026-04-17

### Added
- **Ctrl+V paste de imagen directo**. Antes solo funcionaba `/paste [texto]` explícito; ahora puedes hacer recorte con `Win+Shift+S` (Snipping Tool) o copiar cualquier imagen al portapapeles y pulsar Ctrl+V en el prompt de sq — detecta el clipboard via PowerShell/osascript/xclip, borra el byte `\x16` que readline insertó, usa lo que ya tenías tecleado como prompt (o "describe esta imagen" por defecto) y manda el mensaje multimodal. Sin imagen en clipboard, Ctrl+V sigue siendo no-op como antes. Funciona en los 3 OS.

  Nota: la primera vez en Windows tarda 1-2s por el cold start de PowerShell. Las siguientes son instantáneas mientras el proceso hijo esté vivo en caché del SO.

## [0.31.4] - 2026-04-17

### Added
- **Cache savings visible en los 3 providers**. Antes solo capturábamos `cacheRead` para Anthropic; ahora también OpenAI (`prompt_tokens_details.cached_tokens` — cachea auto prompts >1024 tok, descuento ~50%) y Google Gemini 2.5+ (`cachedContentTokenCount`, descuento ~25%). `/cost` muestra `X% cached` por modelo en verde y el total. `estimateCost` aplica los ratios correctos (10% Anthropic, 25% Google, 50% OpenAI) sobre los cached tokens en lugar de cobrarlos a precio completo.

### Fixed
- **Texto "Anthropic only" en la doc de prompt caching** estaba mal. OpenAI y Google también cachean, solo que de forma automática sin `cache_control`. Clarificado en CHANGELOG y respuestas de sq.

## [0.30.3] - 2026-04-17

> **Nota de versionado:** a partir de esta versión, +1 minor por cada feature
> y +1 patch por cada fix. Lo que antes iba a llamarse 0.16.0 en realidad
> contiene 15 features + 3 fixes desde 0.15.2 → 0.30.3.

### Added
- **`/resume`** — picker interactivo (↑↓) de sesiones guardadas dentro del REPL. Reanuda con el historial + modelo de la sesión elegida. Hasta ahora resume solo existía como CLI flag (`sq --continue`).
- **`/review [rango]`** — review estilo PR del `git diff` actual. Sin rango mete staged + unstaged; con rango (ej. `/review HEAD~3`) acota. Inyecta el diff en un prompt con secciones de Resumen / Posibles bugs / Sugerencias / Tests y lo manda al modelo activo. Trunca a 100k chars para no reventar el contexto.
- **`/undo`** — revierte el último `Edit` o `Write`. Stack in-memory de 50 niveles; snapshot del contenido previo antes de cada modificación. Si el fichero no existía (Write creó uno nuevo), `/undo` lo borra.
- **`/sessions`** — gestión de sesiones guardadas con subcomandos:
  - `/sessions` o `/sessions list` → count + tamaño total en disco + más antigua/reciente + contador de stubs + política de retención activa.
  - `/sessions prune [N]` → borrado manual de stubs (sesiones sin mensaje de usuario) + sesiones más antiguas que N días (default 90).
  - `/sessions retain N` → persiste `[sessions] auto_prune_days = N` en `~/.squeezr-code/config.toml`; a partir del siguiente arranque, sq borra sesiones > N días automáticamente. `retain 0` u `off` lo desactiva.

  Default: **no se borra nada**, igual que Claude Code. Hasta que tú no pongas `retain N`, las sesiones viven para siempre en `~/.squeezr-code/sessions/`.
- **`/paste [texto]`** — lee imagen del portapapeles (Windows/macOS/Linux nativo, sin dependencias extra) y la manda al modelo multimodal junto con un prompt opcional. Shell-out por plataforma: PowerShell + System.Windows.Forms en Windows, osascript con `«class PNGf»` en macOS, xclip/wl-paste en Linux. Cap 5 MB para no reventar el contexto.
- **Plan mode real** con `ExitPlanMode` tool. En mode `plan`, el agente puede usar Read/Grep/Glob libremente pero Write/Edit/Bash están bloqueadas. Cuando tiene el plan listo, llama a `ExitPlanMode(plan: markdown)` — sq pinta el plan en un bloque, pregunta al usuario `y/n`, y si acepta cambia el mode a `accept-edits` para que pueda implementar. Si rechaza, sigue en plan mode. Imita el flow de Claude Code.
- **PDF reading en el tool `Read`** — detecta `.pdf` por extensión, extrae texto con pdf-parse. Para PDFs > 10 páginas, exige rango explícito via `pages: "1-5"` (max 20 páginas por call). Separa por form-feed `\f` cuando está presente; si no, fallback a texto entero con warning.
- **Extended thinking con keywords** — detecta `think` / `think hard` / `think harder` / `ultrathink` en tu prompt (case-insensitive, palabra completa). Mapea a budget de thinking: 4k / 10k / 32k / 32k tokens. Solo aplica a Anthropic. Ahorra al usuario tener que tocar flags o config.
- **Prompt caching automático (Anthropic)** — marca la última tool definition y el último bloque del system prompt con `cache_control: { type: 'ephemeral' }`. Anthropic cachea esas secciones durante 5 min y los siguientes turnos pagan 0.1× en lugar de 1× esos input tokens. Con una conversación de ~10 turnos, ahorra ~70% del gasto en input.
- **Auto-compact** — tras cada turno, si `contextPercent >= transplant.auto_threshold` (default 95%) y hay más de 4 mensajes en el historial, sq ejecuta `agent.compact()` automáticamente. Aviso visible `▸ contexto al X% — compactando automáticamente…` + `✓ historial comprimido`. Evita tener que mirar la barrita y acordarte de hacer `/compact` a mano.
- **Auto-update check** — al arrancar, consulta `registry.npmjs.org/squeezr-code/latest` con timeout 2s y cache 24h en `~/.squeezr-code/update-check.json`. Si hay versión nueva, banner: `↑ nueva versión X.Y.Z disponible · npm i -g squeezr-code@latest`. Non-blocking, silencioso si offline.
- **Tab completion de rutas** — `@src/<TAB>` ahora lista el directorio y completa paths reales. `@opus/sonnet/haiku/...` sigue funcionando para modelos. El distinguidor: si el token tiene `/`, `\`, `.` o `~` lo trata como path; si no, como alias de modelo.
- **Google quota en el status bar** — barrita 5h/% para Gemini. Google no expone headers de ratelimit, así que lo sintetizamos cliente-side: rolling window de tokens de los últimos 5h contra un presupuesto plausible de ~2M tok (Code Assist free tier). Mejor que nada.
- **Nombres de modelo completos** — el status bar ya no recorta a `opus`/`sonnet`/`haiku`; ahora muestra la versión real parseando el id (`claude-opus-4-6-…` → `opus 4.6`). Igual para `gpt-5-codex`, `o4-mini`, `gemini 3.1 pro`.

### Fixed
- **Stack overflow al primer prompt con pin OFF**. El wrapper `w()` del renderer tenía un typo: si pin estaba deshabilitado llamaba a sí mismo (`w(text)`) en lugar de `process.stdout.write(text)` → recursión infinita al primer write. Peor aún con v0.15.2 donde el pin pasó a OFF por default, haciendo crashear el REPL al primer turno.
- **Mensaje del modelo duplicado tras `done`**. El streaming híbrido escribía chars plain y luego en `done` re-renderizaba el buffer con markdown aplicado. `\r\x1b[K` solo limpia la fila actual del terminal; si el plain text había hecho wrap, el re-render se superponía → veías la misma respuesta dos veces (y la primera con UTF-8 partido al medio en emojis). Fix: no re-renderizar en `done`; la línea parcial queda como plain-streamed. Markdown inline se aplica al cerrar cada `\n` como antes.
- **Mensaje del usuario duplicado tras Enter**. `renderStatus` devuelve un prompt de 4 filas (`\n[status]\n[mode]\n❯ `). Al pulsar Enter, readline dejaba las 4 filas visibles con `❯ hola` dentro, y encima imprimíamos `│ you / │ hola` → el usuario veía su mensaje dos veces. Fix: antes de escribir el bloque `│ you`, emitimos `\x1b[4A\r\x1b[J` para borrar el prompt multi-línea. Skipped cuando pin está activo o cuando viene de continuación `\`.

### Changed
- **Fondo gris en el mensaje del usuario** — las dos filas (`│ you / │ hola`) ahora van con `\x1b[48;5;236m` de borde a borde (usa `\x1b[K` para heredar el bg hasta el final de la fila), mimicking Claude Code's chat bubble style.
- **Mejores errores**. `formatError` detecta y sugiere fixes para casos comunes:
  - `404 / "not found" / "requested entity"` → sugiere 3 modelos válidos del provider (`prueba con: opus-4.6, sonnet-4.6, haiku-4.5`).
  - `400 + "context length / token limit / maximum context"` → `usa /compact o /clear`.
  - `400 + "invalid request"` → imprime el mensaje real de la API truncado.

### Notes
- **Memoria 5h de Google se pierde al reiniciar**. El bucket vive en process memory — esperado, no persistimos cross-session. Si Google publica un endpoint real, parsearemos el valor en lugar de sintetizar.
- **`/review` usa `git diff` directo** (no pasa por proxy, no se cachea). Requiere que el cwd sea un repo. Si el diff está vacío, avisa y no manda nada al modelo.

## [0.15.2] - 2026-04-17

### Fixed
- **Barras `│` desalineadas / output raro**. readline pone el terminal en raw mode donde `\n` solo baja una fila SIN carriage return (no vuelve a col 1). Entonces cualquier `\n│ ` del renderer aparecía desplazado a la columna donde estábamos antes del `\n`. Fix: `writeOutput` ahora normaliza `\n` → `\r\n` antes de enviar al terminal.
- **No se podía hacer scroll**. El alt screen buffer (`\x1b[?1049h`) deshabilita el scrollback del terminal. Quitado. Mantenemos solo DECSTBM scroll region — el usuario puede hacer scroll up con mouse/teclado para ver output pasado.
- **El mensaje del usuario no aparecía tras Enter**. Claude Code muestra tu mensaje como parte del historial visual en el output area. Ahora sq también: tras Enter, escribe `│ you\n│ <tu mensaje>` en el scroll region antes de la respuesta del agente.
- **Banner SQUEEZR grande siempre**. El usuario prefiere el ASCII art aunque use pin_input_bottom, que la compact version queda pobre.

## [0.15.1] - 2026-04-17

### Fixed
- **`require is not defined`** tras cada turno largo (>30s). `ansi.ts.osNotify()` usaba `require('node:child_process')` dinámico en un paquete ESM. Cambiado a top-level `import { spawn } from 'node:child_process'`.
- **Markdown no se renderizaba** durante streaming. Había quitado el line-buffering en v0.14.8 para fluidez, pero markdown aparecía literal (`## heading`, `**bold**`, etc). Nuevo enfoque híbrido: los chars se muestran plain al instante (fluidez), y cuando llega `\n` borro la línea y re-renderizo con markdown aplicado (`\r\x1b[K` + writeMdLine). Ahora tienes fluidez + markdown bonito al final de cada línea.
- **Prompt no se limpiaba tras Enter** con pin_input_bottom. Readline deja la línea del prompt intacta con el texto que enviaste hasta que rl.prompt() la redibuja (al final del turno). Fix: inmediatamente después de que se valida el input, limpiamos la fila del prompt con `positionPromptCursor()` y escribimos `❯ ` vacío.
- **Input echo en output area** — `writeOutput` ahora usa DECSC/DECRC (`\x1b7`/`\x1b8`) para guardar/restaurar el cursor antes/después de escribir. Así si readline estaba echoando teclas del usuario en el prompt row, después de un write de output el cursor vuelve al prompt row automáticamente. No más chars tipeados apareciendo en zonas raras del scroll region.

## [0.15.0] - 2026-04-17

### Added — Input pinned al bottom que por fin funciona
Tras 4 intentos fallidos en v0.14.x, v0.15 reescribe el screen management de cero con la arquitectura correcta:

- **`src/repl/screen.ts` nuevo** — usa:
  1. **Alternate screen buffer** (`\x1b[?1049h`) — aislamiento del terminal principal, como tmux/vim/less. Al salir, el terminal vuelve a como estaba.
  2. **Scroll region DECSTBM** (`\x1b[1;<H-4>r`) — output scrollea SOLO en las filas de arriba.
  3. **Absolute positioning** para las filas fijas (status, mode) con `\x1b7`/`\x1b8` (DECSC/DECRC).
  4. **Buffer row** al final — evita que `\n` del Enter scrolee fuera de sitio.

- **Layout final:**
  ```
  row 1 ... row H-4    → scroll region (output del agente)
  row H-3              → status line (proyecto · % · modelo)
  row H-2              → mode line (↳ mode · shift+tab)
  row H-1              → prompt (❯ lo que escribes)
  row H                → buffer vacío
  ```

- **Renderer refactored** — todas las writes pasan por `w()` que enruta a `screen.writeOutput()` cuando pin está activo, o a `process.stdout.write` cuando no. Garantiza que el cursor siempre esté en la scroll region antes de escribir.

- **Spinner refactored** — también usa el wrapper, así su `\r\x1b[K{text}` escribe dentro del scroll region y no se mete en el área pinned.

- **Orden de arranque corregido** — `enableScreen()` se llama ANTES de `renderWelcome`, así el banner entra directo en la alt screen (no deja rastros en el terminal principal).

- **`pin_input_bottom = true` por default** ahora que funciona.

### Changed
- `screen.ts` API rediseñado: `enableScreen`, `writeOutput`, `drawInputArea`, `positionPromptCursor`, `cleanup`. Los nombres antiguos (`enableScreenLayout`, `drawFixedLines`, etc) se quitaron.

### Notes
- Requiere terminal con soporte para alt screen buffer + DECSTBM. Windows Terminal, WezTerm, iTerm2, Kitty, Alacritty, tmux — todos soportan. PowerShell conhost muy antiguo quizá no. Pon `[display] pin_input_bottom = false` si tu terminal da problemas.
- Al cerrar sq (`/exit`, `Ctrl+C`, `rl.close`), el terminal vuelve a como estaba antes, sin dejar basura visual.

## [0.14.8] - 2026-04-17

### Changed
- **Streaming char-by-char real**. Antes el texto se buffereaba hasta ver `\n` para aplicarle markdown, así que para respuestas largas (paragraph sin newlines intermedios) aparecía el párrafo entero DE GOLPE tras un silencio de varios segundos. Ahora cada chunk se escribe directo a stdout conforme llega de la API, con wrap manual y la barrita `│` a la izquierda.
  - Trade-off: durante streaming ya no se aplica markdown (`**bold**`, `## heading`, etc aparecen literales). El precio de la fluidez visual.
  - Para respuestas cortas que entran en un solo chunk no se nota cambio.
  - El renderer guarda `mdBuffer` por compatibilidad pero ya no se usa para re-render. Se quitará en v0.15.

### Known pending
- `pin_input_bottom` sigue experimental (default false). Implementación decente requiere refactor del renderer para que todas las writes pasen por un wrapper que posicione el cursor correctamente. Pospuesto a v0.15.

## [0.14.7] - 2026-04-17

### Fixed
- **Tras usar un slash command (`/model`, `/mcp`, `/compact`, `/login`), el siguiente mensaje se quedaba encolado y nunca se procesaba.** Causa: cuando introduje el queueing en v0.14.2, puse `isProcessing = true` al inicio del line handler y `isProcessing = false` solo en el `finally` del `agent.send`. El path de slash commands retornaba sin tocar el `finally`, así que `isProcessing` se quedaba a `true` de forma permanente. Siguiente Enter → "queued" pero nada lo procesa.
- Fix: `isProcessing = true` ahora se setea JUSTO antes de `agent.send()`, no al principio. Los slash commands son síncronos (o abren pickers que pausan rl por su cuenta) y no necesitan marcar processing.

## [0.14.6] - 2026-04-17

### Changed
- **`pin_input_bottom` pasa a `false` por default y queda como experimental**. Las 3 iteraciones que hice (v0.14.0, v0.14.4, v0.14.5) no resuelven del todo el problema porque el renderer actual escribe a stdout sin coordinar con el cursor position — con scroll region activo el output aparece en lugares raros (hueco gigante entre banner y prompt, input desaparece tras el 2º mensaje, etc).
- Hacerlo funcionar bien requiere reescribir el renderer completo (`writeWrapped`, `markdown`, `spinner`, cada evento) para llamar a `positionOutputCursor()` antes de cada write. Es un refactor grande que planeo para v0.15+.
- Mientras tanto sq usa el banner ASCII grande de siempre y el prompt inline (status + mode + ❯ en las últimas líneas del output, no pinned). Funciona en todos los terminales.

## [0.14.5] - 2026-04-17

### Fixed (iteración 2 de pin_input_bottom)
- **Hueco gigante entre banner y prompt** al arrancar con `pin_input_bottom = true`. El banner ASCII grande ocupaba 13 filas del scroll region, dejando ~10+ filas vacías antes del status/mode/prompt (que van a filas absolutas abajo). Ahora sq elige qué banner mostrar según el modo:
  - `pin_input_bottom = true` → banner compacto (4 líneas) con `▌` como separador.
  - `pin_input_bottom = false` → banner ASCII grande como antes.
- **Input "desaparecía" al mandar 2º mensaje** porque el prompt estaba en la última fila del terminal. Al pulsar Enter allí, `\n` fuerza scroll del terminal entero (incluso con DECSTBM), desplazando una fila arriba las líneas fijas. Ahora:
  - Scroll region: `[1, H-4]`
  - Fila H-3: status
  - Fila H-2: mode
  - Fila H-1: prompt (❯)
  - Fila H: buffer vacío — Enter desde prompt baja a esta fila sin scrollear fuera, las fijas no se mueven.

## [0.14.4] - 2026-04-17

### Added
- **Input pinned al bottom FUNCIONA de verdad** (antes en v0.14.0 lo metí a medias y quedaba un hueco enorme entre banner y prompt). Reescrito limpio:
  - Scroll region DECSTBM `\x1b[1;<rows-3>r` reserva las últimas 3 filas del terminal para status/mode/prompt.
  - `renderer.renderStatusLine()` separado de `renderer.renderStatus()`: devuelve solo la línea (sin `\n`) para absolute positioning.
  - `screen.drawFixedLines(status, mode)`: escribe status/mode en sus filas absolutas (`\x1b[row;colH`) guardando y restaurando el cursor con `\x1b7`/`\x1b8` (DECSC/DECRC) — más fiable que `\x1b[s/u` en terminales modernos.
  - Readline prompt reducido a `❯ ` (single line) cuando `pin_input_bottom = true`.
  - Tras cada evento del renderer (text, tool_start, etc), `drawPinnedLines()` redibuja status/mode para mantenerlos visibles aunque el output scrolee.
  - `positionPromptCursor()` antes de `rl.prompt()` garantiza que el cursor esté en la fila correcta del prompt.
  - `pin_input_bottom = true` ahora es el default. Si te da problemas en tu terminal (conhost antiguo, tmux viejo), pon `false` en sq.toml.
- **Color del project name cambiado de cyan → verde** para casar con la nueva paleta. Antes salía en cyan, el usuario lo veía como "azul".

### Known limitations
- En terminales sin soporte de DECSTBM (PowerShell conhost muy antiguo), el layout no funciona. Pon `pin_input_bottom = false` para deshabilitar.

## [0.14.3] - 2026-04-17

### Changed
- **Paleta de colores cambiada de azul → verde** en todo el REPL. Afecta:
  - Banner ASCII `SQUEEZR CODE` (gradiente verde oscuro → lima)
  - Prompt `❯` (ahora verde medio)
  - Headings markdown H1/H2/H3 (verde brillante → oscuro)
  - Wizard de onboarding (caja de bienvenida)
  - `gradient()` helper para textos importantes
- Paleta 256-color: `22, 28, 34, 40, 46` (oscuro → brillante lima).

## [0.14.2] - 2026-04-17

### Added
- **Input activo durante turnos + cola de mensajes** (estilo Claude Code). Antes `rl.pause()` bloqueaba el input mientras sq procesaba. Ahora:
  - Readline sigue activo mientras el modelo piensa / tool runs.
  - Puedes escribir y pulsar Enter para enviar OTRO mensaje — se encola.
  - `· queued (N pending)` te confirma que entró en la cola.
  - Al terminar el turno actual, sq procesa automáticamente el siguiente en cola (`rl.emit('line', next)` via `setImmediate`).
  - Puedes encolar cuantos mensajes quieras.
- Esc unificado: durante un turno aborta el turno actual (vía `agent.abortCurrent()`), cuando estás escribiendo limpia la línea actual.

### Changed
- `rl.pause()` / `rl.resume()` ya no se llaman durante el turno principal. El listener raw de stdin para abortar se reemplaza por el keypress handler global (funciona porque readline ya no está pausado).
- Los pickers (`/model`, `/mcp`, `/login`, `/compact`) siguen pausando readline localmente (necesario para que los pickers gestionen stdin en raw mode sin conflicto con readline).

### Known limitations
- El spinner (`⠙ pensando 3s`) puede solaparse visualmente con lo que estés escribiendo, ya que ambos escriben en la misma terminal. Es cosmético — funcional sigue bien. Arreglo completo requiere `pin_input_bottom` pulido (pospuesto).

## [0.14.1] - 2026-04-17

### Fixed
- **Hueco enorme entre welcome banner y prompt** cuando `pin_input_bottom = true`. El scroll region reservaba 4 filas abajo pero el prompt multi-línea de readline (`\n{status}\n{mode}\n❯`) scrollea DENTRO de la región, dejando las 4 filas reservadas vacías. Default cambiado a `false` para que sq se vea bien out-of-the-box. La feature queda disponible como flag experimental hasta que reescribamos `renderStatus` con absolute positioning para aprovechar correctamente la zona pinned.

## [0.14.0] - 2026-04-17

### Added — UX estilo Claude Code (nivel 2)
- **Permission picker rico** con estilo de Claude Code. Cuando una tool peligrosa está a punto de ejecutarse en modo `default`, sq abre un picker interactivo:
  ```
  ? Allow Edit?  src/foo.ts
    ❯ Yes                                                      allow just this call
      Yes, and don't ask again for Edit this session           until sq closes
      Yes, and don't ask again for Edit matching src/**        pattern match only
      No, and tell the model what to do instead                denies + user message
  ```
  - ↑↓ navegar · enter seleccionar · hotkeys `y`/`a`/`p`/`n` · esc cancelar
  - **Session-level allowlist**: `yes-tool-session` o `yes-pattern-session` persisten la regla en memoria (hasta cerrar sq). El próximo `Edit` (o el que matchee el pattern) se auto-aprueba.
  - **No + explain**: al elegir "No", sq pide texto libre que se devuelve al modelo como tool_result (`Tool denied by user: <tu mensaje>`), así el modelo aprende qué hacer diferente.
  - Preview del diff (con `+` verde y `-` rojo) sigue apareciendo antes del picker.
- **Onboarding wizard primera vez** — Si `~/.squeezr-code/config.toml` no existe, sq lanza un wizard que te guía por:
  1. Detección de providers autenticados (si no hay ninguno, te dice qué comando ejecutar).
  2. Picker de modelo default (filtrado por providers disponibles).
  3. Picker de modo de permisos (`default`/`accept-edits`/`plan`/`bypass`).
  4. Genera el `config.toml` con los valores elegidos.
  - `sq --skip-onboarding` lo salta si ya sabes lo que haces.
- **Input pinned al bottom del terminal (scroll region / DECSTBM)** — Las últimas 4 líneas (status, mode, prompt) quedan fijas abajo. El output del agente (texto del modelo, tools, diffs, recaps) scrollea SOLO en la región de arriba. Cuando un turno termina, el prompt sigue visible abajo sin que tengas que hacer scroll.
  - Implementación: `\x1b[1;<bottom-4>r` (DECSTBM) al arrancar el REPL. `\x1b[r` al cerrar para resetear. Listener `resize` para recalcular en SIGWINCH.
  - Config: `[display] pin_input_bottom = true` (default). Si tu terminal no soporta DECSTBM correctamente, pon `false` para volver al flujo normal.

### Changed
- `askPermission` ahora devuelve `{ approved: boolean, explanation?: string }` en lugar de `boolean`. El `explanation` se concatena al tool_result cuando el usuario niega, para que el modelo sepa qué hacer después.
- `ToolExecOpts.askPermission` tiene nuevo tipo coherente.
- `SqAgent.send()` acepta el nuevo tipo en sus opts.

## [0.13.4] - 2026-04-17

### Added — Modos estilo Claude Code con Shift+Tab
- **4 modos de operación** que se ciclan con `Shift+Tab`:
  - **`default`** (cyan) — pregunta antes de Bash/Write/Edit/NotebookEdit. El modo de siempre.
  - **`accept-edits`** (amarillo) — auto-aprueba Write/Edit/NotebookEdit, sigue preguntando Bash. Útil cuando ya confías en el plan y quieres que el agente aplique cambios sin interrumpir, pero reteniendo control sobre los comandos shell.
  - **`plan`** (magenta) — solo-lectura. Bloquea Bash/Write/Edit/NotebookEdit (el modelo ve las tools pero al invocarlas fallan con un mensaje claro). Útil para investigar y proponer antes de ejecutar. Sales a otro modo con Shift+Tab para aplicar.
  - **`bypass`** (rojo) — aprueba TODO sin preguntar. Alias de `yolo`/`auto` (legacy). Peligroso.
- **Indicador de modo bajo el prompt**: línea `↳ default · shift+tab to cycle` siempre visible debajo del `❯`, con color por modo. Se actualiza al ciclar.
- **Shift+Tab universal**: funciona en cualquier momento mientras el REPL espera input (no durante turnos; el shift+tab en turno se ignora para no romper nada).
- **Runtime**: el modo cambia inmediatamente. Si estabas en plan mode y cicláis a default, el siguiente turno el modelo ya puede usar Edit.

### Changed
- `SqAgent.setPermissionMode(mode)` / `getPermissionMode()` públicos para cambiar en runtime desde el REPL.
- `ToolExecOpts.permissions` amplía el union a `'default' | 'accept-edits' | 'plan' | 'bypass' | 'auto' | 'yolo'`. Los legacy `auto`/`yolo` se normalizan a `bypass` al arrancar.
- Executor: nueva cascada de decisión en este orden:
  1. Reglas granulares allow/deny (siguen igual)
  2. Plan mode: bloquea modificadoras con mensaje
  3. Bypass/auto/yolo: aprueba todo
  4. Accept-edits: aprueba edits, pregunta Bash
  5. Default: pregunta lo peligroso

## [0.13.3] - 2026-04-17

### Fixed
- **`@5.3-codex` (o cualquier alias con `.`) se trataba como file path** y daba "no encontrado". Mi regex antiguo consideraba cualquier `@` con `/`, `\`, `.` o `~` como file mention, pero los aliases de modelos Codex (`5.3-codex`, `5.4-mini`) contienen puntos. Nueva lógica: primero busca si el token es un alias conocido (`getAliasKeys()` + aliases que empiezan por dígito), sólo si no lo es Y parece path (`/`, `\`, `~`, `./`, `../`) lo trata como file.
- **`/model` y `/mcp` pickers apilaban draws al navegar con flechas**. Usaban `\x1b[s`/`\x1b[u` (save/restore cursor) que falla en terminales que no lo soportan o cuando hay scroll entre frames. Ambos reescritos con el mismo patrón que `AskUserQuestion`: tracker manual de `linesWritten` + `\x1b[<n>A\x1b[J` para sobrescribir limpio en cada redibujo.

## [0.13.2] - 2026-04-17

### Fixed
- **`/agents` persistentes ahora funcionan de verdad.** En v0.13.0 creé `agents-store.ts` (lectura de `.md`) pero el wiring con la tool `Task` estaba stubbed — el campo `subagent_type` no existía en la definición de la tool ni llegaba al runner. Arreglado:
  - `Task` tool acepta `subagent_type` como parámetro opcional.
  - `SubAgentRunner` signature recibe el subagent type.
  - `runSubAgent` en repl.ts carga el `.md` con `findAgent()`, aplica `model` como override, pasa `systemPrompt` como `appendSystemPrompt` y `tools` como `toolsAllowed`.
  - `AgentConfig` añade `appendSystemPrompt` y `toolsAllowed`. El sub-agente filtra `SQ_TOOLS` por `toolsAllowed` antes de enviar al LLM (sólo las tools permitidas aparecen en el catálogo del modelo).

## [0.13.1] - 2026-04-17

### Added
- **`Esc` con dos comportamientos** (estilo Claude Code):
  - **Mientras escribes**: borra todo el buffer del input. Como `Ctrl+U` pero más natural. Implementado vía `keypress` listener que detecta `escape` y resetea `rl.line` + `rl.cursor`.
  - **Mientras sq procesa** (spinner corriendo, esperando modelo o tool): aborta el turno limpiamente. Cierra el adapter (cancela stream HTTP/SSE / WebSocket / fetch), marca `aborted=true` en el agente, y el loop sale al final de la iteración actual con un evento `error: 'Cancelado por el usuario (Esc)'`. El REPL devuelve control al prompt sin restos.
- **`Ctrl+C` durante turno**: mismo comportamiento que Esc — aborta. (Antes solo cerraba sq entero.)

### Changed
- **`SqAgent.abortCurrent()`** público — el REPL lo llama cuando detecta Esc/Ctrl+C en raw mode durante el turno.
- El handler del turno instala un listener `data` adicional sobre stdin (porque `rl.pause()` mata los keypress events), lo quita en el `finally`. Esc solo se procesa por uno de los dos paths a la vez.

## [0.13.0] - 2026-04-17

### Added — Paridad de features con Claude Code / Gemini CLI
- **`@file` mentions en prompts** — `@README.md explica esto` lee el fichero y lo inyecta inline como bloque de código con ` ``` ` fence. Soporta paths absolutos, relativos, `~` y directorios (lista ficheros). Límite 200KB por fichero. El `@modelo` override sigue funcionando (se distingue porque no contiene `/ \ . ~`).
- **Memory hierarchy multi-nivel** — sq lee en orden:
  1. `~/.squeezr-code/SQUEEZR.md` o `~/.claude/CLAUDE.md` (user-level)
  2. `<project root>/SQUEEZR.md` o `CLAUDE.md` (walking-up desde cwd)
  3. `<cwd>/SQUEEZR.md` o `CLAUDE.md` (si cwd ≠ project root)
  Cada fichero soporta `@import path` para incluir otros .md de forma modular. Total truncado a 30KB.
- **`/context`** — muestra estado del context window: tokens estimados de system prompt, historial por rol (user/assistant/tool), con conteos de mensajes y % de utilización de la ventana.
- **`/export [path]`** — exporta la conversación actual a markdown (default) o JSON (`.json`). Sin path: genera `sq-<sessionId>.md` en cwd.
- **`sq -c` / `sq --continue`** — shortcut para `sq resume` (reanuda la última sesión).
- **`sq search "query"`** — busca la query en TODAS las sesiones guardadas, muestra snippets por turno.
- **`/usage`** — estadísticas agregadas: sesiones totales, mensajes, por-modelo, por-día (bar chart).
- **`/release-notes`** — muestra la sección del CHANGELOG correspondiente a la versión actual.
- **`/feedback`** — muestra URL de issues y email para feedback.
- **Custom slash commands (skills)** — drop-in `.md` en `~/.squeezr-code/commands/<name>.md` con frontmatter YAML opcional. Ejecutar `/<name>` expande el contenido como prompt al modelo. Soporta `$ARGS` en el body. Formato:
  ```
  ---
  description: Review pending changes
  ---
  Review the current git diff. $ARGS
  ```
- **Hooks system** — scripts del usuario que sq ejecuta en eventos:
  - `PreToolUse` (con matcher regex sobre nombre del tool)
  - `PostToolUse`
  - `UserPromptSubmit` (el prompt llega por stdin al hook)
  - `Stop` (al terminar el turno)
  Configurado en `~/.squeezr-code/settings.json` con `{ "hooks": { "PostToolUse": [{ "matcher": "Edit", "command": "prettier --write ${input.file_path}" }] } }`. Fire-and-forget, no bloquea el agente.
- **Persistent sub-agents** (`~/.squeezr-code/agents/<name>.md`) — cada agente tiene su propio system prompt + tools restringidas + model opcional, definidos como frontmatter YAML. Invocables desde el modelo con `Task(subagent_type='<name>', ...)`.
- **Themes** — `[display.theme]` en sq.toml con `dark` (default) | `light` | `solarized` | `nord`. Tabla de colores intercambiable.
- **Statusline custom commands** — `[statusline.commands]` array de comandos shell cuyo output aparece en el status bar (con cache de N segundos). Ej: `["git rev-parse --short HEAD", "node -v"]`.
- **Vim mode** para el input — `[display.vim] = true` (stub, readline no soporta vim nativamente pero el flag está listo para futura integración con un line editor externo).
- **Sandboxing Docker para Bash** — `[sandbox] enabled = true, image = "node:20-alpine"`. Envuelve cada Bash en `docker run --rm -v cwd:/workspace -w /workspace <image> sh -c "<cmd>"`. El usuario necesita Docker instalado.

### Changed
- `CommandContext` extendido con `history()`, `systemPrompt()`, `sessionId()` para que los comandos puedan acceder a la sesión.
- `SqAgent` expone `getLastSystemPrompt()` para `/context`.
- `system.ts.loadProjectMemory()` reescrito con multi-nivel + `@import`.
- `executor.ts.toolBash` acepta `sandbox` opt.

### Removed
- **`proxy: { enabled, port }`** en SqConfig movido a placeholder documentado (se mantuvo la sección para v0.14+ integración con squeezr-ai).

## [0.12.4] - 2026-04-17

### Changed
- **Renombrados ficheros y clases para reflejar que sq es standalone**, no un proxy. El nombre `SqProxy` venía del plan original de rutear todo a través de squeezr-ai como MITM, pero ese camino se abandonó (sq habla directo a las APIs con OAuth de suscripción) y el nombre confundía a la gente que pensaba que sq necesitaba un proxy corriendo aparte.
  - `src/proxy/core.ts` → `src/agent/agent.ts`
  - `class SqProxy` → `class SqAgent`
  - `interface ProxyConfig` → `interface AgentConfig`
  - Variables locales `proxy` → `agent` en `repl.ts` y `oneshot.ts`.
  - Nombre de la sub-agente `subProxy` → `subAgent`.

### Removed
- **`src/proxy/proxy.ts`** — código muerto (`isProxyRunning`, `tryStartProxy`, `ensureProxy`) que nadie importaba. Eran helpers para arrancar/comprobar squeezr-ai como proxy externo. Si en v0.13+ integramos squeezr-ai vía peer-dependency lo haremos limpio en `src/compression/` o similar.
- **`src/agent/loop.ts`** — implementación antigua de `agentLoop` no usada (la lógica vive en `SqAgent.send`). Limpieza.
- **`src/proxy/`** — directorio entero borrado.

### Notes
- La sección `[proxy]` en `sq.toml` y `SqConfig.proxy` se mantienen como placeholder documentado para la integración futura con squeezr-ai. Hoy no hace nada.

## [0.12.3] - 2026-04-17

### Fixed
- **Picker de `AskUserQuestion` se duplicaba al pulsar flechas** — el spinner "esperando respuesta" seguía corriendo en su timer y escribía `\r\x1b[K{texto}` cada 80ms, rompiendo el `\x1b[s`/`\x1b[u` (save/restore cursor) del picker. Dos fixes en cascada:
  1. `Renderer.stopSpinnerExternal()` público — el REPL lo llama al activar `userQuestioner` antes de abrir el picker.
  2. `askUserInteractive` reescrito con tracker manual de líneas escritas + `\x1b[<n>A\x1b[J` en vez de save/restore cursor. Más robusto cuando hay scroll u output ajeno entre frames.
- **Enter durante "pensando" apilaba spinners al infinito** — readline procesaba cada Enter, redibujaba el prompt (que lleva `\n` del status bar), y el spinner en su timer seguía escribiendo, cada vez en una línea nueva. Fix: `rl.pause()` antes del turno + `rl.resume()` en `finally`. Al resumir se drena `stdin.read()` en bucle y se limpia `rl.line`/`rl.cursor` para que los Enters perdidos no se procesen.
- **Spinner ahora oculta cursor con `\x1b[?25l`** en el picker explícitamente (antes dependía de que el spinner lo hubiera hecho).

## [0.12.2] - 2026-04-17

### Changed
- **System prompt actualizado** con la lista completa de los 14 tools disponibles y reglas de uso. En particular: instrucción explícita de usar `AskUserQuestion` cuando hay ambigüedad o el usuario plantea "X vs Y", en lugar de elegir unilateralmente. Antes el modelo no usaba esta tool casi nunca porque no la conocía bien.

## [0.12.1] - 2026-04-17

### Added
- **Recap automático tras turnos largos** (estilo Claude Code). Cuando un turno dura > 60s con al menos 2 tools usadas, o > 2min sin importar las tools, sq hace una llamada extra al mismo modelo pidiéndole que resuma el turno en 1-2 frases con formato log-entry. Renderizado como:
  ```
  ✻ Churned for 6m 16s

  ※ recap: <text generado por el modelo>
    (disable recaps in sq.toml: [display] recaps = false)
  ```
- Config `[display] recaps = true` (default) en sq.toml para controlarlo. Si lo pones a `false`, sq nunca pide recap. Env var: `SQ_RECAPS=0 sq` también lo desactiva.
- **`AgentEvent.recap`** — nuevo tipo de evento con `text` + `elapsedSec` para que el renderer lo pinte.
- **`SqProxy.streamRecap()`** — método privado que hace la llamada extra con el historial post-turno + prompt específico ("1-2 frases, formato verbo+qué, next:..."). El recap NO se persiste en `conversationHistory` (es meta-información, no forma parte del diálogo real).

### Changed
- One-shot mode (`sq -p`) siempre tiene `recaps=false` — queremos output limpio para scripts/pipes, sin el meta-recap.

## [0.12.0] - 2026-04-17

### Added — Pulido UI estilo Claude Code
- **Hyperlinks OSC 8 clicables** — paths en tool calls (Read/Write/Edit `foo.ts`) y URLs en WebFetch ahora son clicables con Ctrl+click en terminales modernos (iTerm2, WezTerm, Windows Terminal, Kitty). Terminales sin soporte muestran solo el texto subrayado.
- **Spinner contextual con stages** — en lugar de "ejecutando Read", ahora dice "leyendo" / "escribiendo" / "buscando" / "descargando" / "delegando a sub-agente" según el tool. Map en `TOOL_STAGE` por nombre.
- **Hint "esc to cancel" en spinner** — cuando lleva > 3s, aparece junto al spinner para que el usuario sepa que puede abortar.
- **Turn summary tras `╰──`** — micro-resumen estilo `· 3 tools (Read×2 Bash) · 1.2k tok · 2.3s · +1 ~2`. Muestra tools usadas (con conteos), tokens totales, tiempo, y ficheros creados (`+`) o modificados (`~`).
- **Notificación nativa al terminar turno largo** — si el turno tarda > 30s, beep ASCII (`\x07`) + notificación del OS (Windows Toast vía PowerShell, macOS via osascript, Linux via notify-send). Útil para builds o investigaciones largas.
- **Gradient en H1 markdown** — los `# Heading` se renderizan con el gradiente azul→cian del banner. H2 y H3 mantienen color sólido.
- **TaskList inline tras turno** — cuando el modelo usa `TaskCreate`/`TaskUpdate`, al terminar el turno aparece el checklist actualizado con `✓` (completed verde), `⋯` (in_progress amarillo), `○` (pending gris).
- **Multi-line input con `\` continuation** — termina una línea con `\` y sq pide otra línea más con prompt secundario `... `. Útil para pegar prompts largos o componer instrucciones multi-paso. Enter sin `\` final submite todo el bloque.
- **Completion hints debajo del prompt** — al escribir `/` se enseña la lista de comandos coincidentes en una línea debajo del input. `/m` filtra a `/model /mcp`. `@` enseña los aliases de modelo. Los hints se borran cuando dejas de escribir un comando.

### Changed
- `Renderer` track tools/tokens/files/time por turno (resets en `api_call_start`).
- `Spinner.render()` añade el cancel hint tras 3s.
- `markdown.ts` H1 usa `gradient()` de `ansi.ts`.
- `installHighlight()` extendido con `showHints()` que pinta y limpia líneas debajo del input.

### Skipped (vienen en v0.13)
- **Input box con borde completo** (`╭── ❯ ──╮`): cosmético y conflictúa con el rendering del status bar; el input actual ya es legible.
- **Nested output para sub-agentes**: requiere refactorizar `runSubAgent` para emitir `AgentEvent` stream en vez de string acumulado. Más invasivo, lo dejo para v0.13.
- **Ctrl+R history search picker**: readline ya tiene Ctrl+R básico. Custom picker bonito en v0.13.

## [0.11.2] - 2026-04-17

### Added
- **Renderer de markdown en el REPL** — Antes la respuesta del modelo aparecía en crudo (`## Heading`, `**bold**`, `` `code` ` literales). Ahora cada línea se renderiza con estilos ANSI:
  - `# H1` / `## H2` / `### H3` en negrita + colores del gradiente del banner
  - `**bold**` → ANSI bold
  - `*italic*` / `_italic_` → ANSI italic
  - `` `inline code` `` → magenta con backticks visibles
  - ` ```code blocks``` ` → fence visual `┌─ lang ─` / `└────`, contenido en cyan dim, sin formato inline aplicado
  - `- list item` → bullet `•` cyan
  - `1. numbered` → número dim
  - `> blockquote` → `┃ ` indent + dim + italic
  - `[text](url)` → link subrayado cyan + URL dim entre paréntesis
  - `---` → línea horizontal dim
- Implementación line-buffered: la primera vez que el modelo emite un `\n`, esa línea se procesa con markdown. Líneas parciales (sin `\n` aún) se acumulan; aparecen cuando llega el salto. Pequeño lag visual a cambio de rendering correcto.
- `writeWrapped` ahora cuenta solo caracteres VISIBLES (no ANSI escapes) — así una palabra coloreada `\x1b[1mfoo\x1b[0m` ocupa 3 columnas, no 11.

### Fixed
- **Bug pre-existente en `writeWrapped`** — el bloque de "trocear palabra extra-larga" tenía las llaves desbalanceadas (faltaban dos `}` de cierre). Compilaba por casualidad pero el `else` del `if (piece.length > maxCol - 2)` quedaba dentro del `while`, no fuera. Reescrito limpio con braces correctos. Mientras esto se haya gestionando con palabras < 80 chars (la mayoría) no se notaba; con URLs largas o paths podría haber duplicado contenido.
- **mdBuffer y col se resetean en `api_call_start`** para que el siguiente turno empiece limpio si el anterior dejó algo a medias.

## [0.11.1] - 2026-04-17

### Fixed
- **Status bar duplicado** al escribir `/` letra a letra (introducido en v0.10.2 con el syntax highlight). Mi `_refreshLine` reescribía el prompt entero, que con el status bar lleva un `\n` dentro — cada letra apilaba un status bar más arriba. Fix: ahora el highlight delega a `origRefresh()` para pintar todo el área (prompt multi-línea incluido) y luego sobrescribe SOLO la zona de la línea (no el prompt) con la versión coloreada usando `\r` + `\x1b[<n>C` para posicionarse después del prompt.

## [0.11.0] - 2026-04-17

### Added — Paridad de tools con Claude Code (de 6 → 14)
- **WebFetch** — descarga URL, convierte HTML → markdown plano (zero-dep, regex naive). Maneja redirects entre hosts.
- **WebSearch** — búsqueda web vía `html.duckduckgo.com/html/`. Sin API key, sin rate limit visible. Soporta `allowed_domains` / `blocked_domains`.
- **BashOutput** + **KillShell** + flag `run_in_background` en **Bash** — procesos largos (dev servers, watchers, builds). `Bash(run_in_background=true)` devuelve `shell_id`; `BashOutput(shell_id)` lee stdout/stderr en cualquier momento; `KillShell(shell_id)` envía SIGTERM y luego SIGKILL si no muere en 2s.
- **TaskCreate / TaskList / TaskGet / TaskUpdate** — lista de TODOs en memoria por sesión. Status: `pending` / `in_progress` / `completed` / `deleted`. Soporta dependencias `blockedBy` / `blocks`.
- **NotebookEdit** — edita celdas de Jupyter (.ipynb). Modos `replace` (default), `insert`, `delete`. Localiza celda por `cell_id` o `cell_number`.
- **AskUserQuestion** — pausa el agente y pregunta al usuario con picker interactivo (single o multi-select, ↑↓ + espacio + enter). Devuelve la(s) opción(es) elegida(s) como tool result.
- **Task** — spawn de sub-agente. Crea un `SqProxy` aislado (mismo auth, cwd, modelo; historial limpio), corre el prompt y devuelve el texto final. Útil para investigación paralela, isolar contexto largo, o tareas especializadas.

### Changed — Upgrades a las 6 tools existentes
- **Edit** acepta `replace_all=true` para todas las ocurrencias (antes solo permitía 1; con varias devolvía error).
- **Grep** reescrito con paridad ripgrep:
  - `output_mode`: `files_with_matches` (default) | `content` | `count`
  - `-i`, `-n`, `-A`, `-B`, `-C` para contexto
  - `multiline`: patrones que cruzan líneas (`. matches \n`)
  - `head_limit` configurable (default 250)
  - Detecta `rg` automáticamente, fallback a `grep` POSIX
- **Bash** mejorado: parámetro opcional `description`, `timeout` cap a 600s, `windowsHide=true`, mejor parsing de signal/code en errores.
- **Glob** sin cambios (ya cubre el caso esencial).

### Internal
- Nuevo módulo `src/tools/web.ts` — WebFetch + WebSearch + parser HTML→md.
- Nuevo módulo `src/tools/background.ts` — store de procesos BG con cleanup al cerrar el REPL.
- Nuevo módulo `src/tools/tasks.ts` — store de TODOs in-memory + snapshot/rehydrate para futuras integraciones con sesión.
- Nuevo módulo `src/tools/notebook.ts` — JSON manipulation para .ipynb.
- Nuevo módulo `src/repl/ask-user.ts` — picker single/multi-select para AskUserQuestion.
- `executor.ts` añade hooks `setSubAgentRunner` y `setUserQuestioner` para que el REPL inyecte los runners de los tools que necesitan recursión o interactividad.
- Renderer: iconos para los 8 tools nuevos (`⤓`, `⌕`, `+`, `≡`, `?`, `⟳`, `▤`, `⤳`).

## [0.10.5] - 2026-04-17

### Changed
- **Auto-import de MCPs de Claude pasa a OPT-IN**. En 0.10.2 lo metí silencioso (sq leía `~/.claude.json` + Claude Desktop al arrancar y mezclaba con `sq.toml`), pero el comportamiento "mágico" generaba confusión sobre qué MCPs eran de quién. Ahora por defecto sq SOLO usa los MCPs declarados en `sq.toml`. Si quieres el comportamiento anterior, hay dos opciones:
  - Flag en sq.toml:
    ```toml
    mcp_auto_import = true
    ```
  - Env var puntual: `SQ_MCP_AUTO_IMPORT=1 sq`

### Added
- **`sq mcp import [--all]`** — comando para importar MCPs de Claude Code, Claude Desktop o `<cwd>/.mcp.json` al `sq.toml` local de forma explícita.
  - Sin flag: picker interactivo multi-select. `↑↓` navega, `espacio` toggle, `a` marca todos, `n` ninguno, `enter` confirma, `esc` cancela.
  - Con `--all`: importa todos los detectados sin preguntar.
  - Filtra los que ya están en `sq.toml` para no duplicar.
  - Append-only al `sq.toml`: añade `[mcp.<name>]` al final con `command`, `args`, `env`. No reformatea el resto del fichero ni pierde comentarios.
  - Tras importar, los MCPs son **tuyos en sq** — no dependes de que Claude esté instalado, y tampoco de auto-discovery.

## [0.10.4] - 2026-04-17

### Fixed
- **`400 tools.N.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`** al mandar tools de MCP a Anthropic. Mi separador de namespace era `:` (`komodo-mcp:search`), pero la API rechaza `:` en nombres de tool — solo acepta letras, dígitos, `_` y `-`. Cambiado a `__` (doble underscore) como separador. Nombres también se sanean: cualquier carácter no válido se reemplaza por `_`.
  - Tool del modelo: `komodo_mcp__search` (el dash del server se mantiene, el `:` pasó a `__`).
  - Al invocar la tool, el manager desanea el nombre para llamar al server MCP con el id original que él conoce (internamente `findOriginalToolName` hace el round-trip).

## [0.10.3] - 2026-04-17

### Fixed
- **sq se quedaba cargando eternamente** cuando había varios MCP servers declarados. `McpManager.start()` esperaba con `Promise.all` a que todos respondieran al `initialize` antes de mostrar el REPL. Un solo server lento (p.ej. planning-task-mcp intentando conectar a Firebase sin el service-account key) bloqueaba hasta el timeout de 30s multiplicado por los que quedasen colgados.
  - `McpManager.start()` ahora es fire-and-forget: registra los servers como `connecting`, lanza los `connect()` en background y devuelve inmediato. El REPL arranca ya.
  - Timeout del `initialize` + `tools/list` bajado de 30s → 8s. Un MCP sano responde en < 500ms.
  - Nuevo status `connecting` (`⋯` amarillo) en el picker. El usuario ve en tiempo real cómo van cambiando a `connected` / `error`.
  - Si un MCP completa `connect` mientras `/mcp` está abierto, hay que pulsar cualquier tecla para ver el refresh (el picker redibuja en keystroke).

## [0.10.2] - 2026-04-17

### Added
- **Auto-descubrimiento de MCP servers de Claude** — al arrancar, sq lee:
  1. `~/.claude.json` (Claude Code user config)
  2. `%APPDATA%/Claude/claude_desktop_config.json` (Claude Desktop, equivalente en mac/linux)
  3. `<cwd>/.mcp.json` (project-level estándar)
  y fusiona `mcpServers` con los de `sq.toml`. Si colisionan por nombre, sq.toml gana; si dos fuentes externas tienen el mismo nombre, se renombra a `<name>@<source>`. Así ya no hay que duplicar config: los MCPs que tienes en Claude Code aparecen en `/mcp` automáticamente.
- **Sintaxis highlight de `/comando` y `@alias`** en el input del REPL (Claude Code style). `/mcp`, `/login`, `/compact`, etc. se ven en cyan según los escribes; `@opus`, `@pro`, etc. en magenta. Implementado con override de `readline._refreshLine` + `_insertString` para forzar refresh en cada tecla.

### Changed
- El welcome banner ahora cuenta MCPs de `sq.toml` + auto-descubiertos, no solo los propios. Puedes verificar qué se cargó con `/mcp`.

## [0.10.1] - 2026-04-17

### Added
- **`/mcp` — picker interactivo de MCP servers**, mismo patrón que `/model` (Claude Code style).
  - `↑↓` navegar
  - `enter` toggle (connect ↔ disconnect)
  - `r` reiniciar el seleccionado (stop + start, útil tras editar config o tras un fallo)
  - `esc` o `q` salir
  - Cada server muestra: dot de status (● connected / ○ disconnected / ✗ error con mensaje), número de tools cuando está connected, comando+args.
- **`McpManager` con API por-server**: nuevos métodos `connect(name)`, `disconnect(name)`, `restart(name)`, `list()` que devuelve snapshot completo (status + lastError + toolCount) para el picker. Antes solo había `start(specs[])` y `stopAll()`.

### Changed
- El manager mantiene los `spec` originales en memoria así puede reconectar tras un disconnect manual. Servers que fallan al arrancar siguen apareciendo en `/mcp` con status `error` y mensaje, y se pueden reintentar con `r` sin reiniciar sq.

## [0.10.0] - 2026-04-17

### Added
- **Thinking / extended reasoning blocks** — Anthropic (`thinking_delta`), Gemini (`parts[].thought`) y Codex (`response.reasoning_text.delta`) ahora se renderizan en gris atenuado bajo la barrita con el marcador `✻`. No se persisten en historial (los providers no esperan ver thinking previo en turnos siguientes). Token ya pagado, pérdida cero.
- **Non-interactive mode** — `sq -p "prompt"` y `cat log | sq -p "resume los errores"`. Un turno, imprime respuesta en stdout, sale. Pensado para scripts y pipelines. `sq -p "..." --model opus` selecciona modelo. En este modo los permisos van a `yolo` automáticamente (no hay TTY para preguntar), pero las reglas `deny` de `sq.toml` siguen aplicando.
- **Diffs visuales en `Write` y `Edit`** — antes de aprobar la tool, el REPL enseña un unified diff con líneas `+/-` coloreadas y 3 líneas de contexto. Para `Write` de fichero nuevo, muestra las primeras 40 líneas como `+`. Para `Edit`, el hunk exacto del reemplazo. Implementado con LCS en `src/tools/diff.ts`.
- **`/compact`** — resume la conversación con el modelo actual y reemplaza el historial por un único par user+assistant con el resumen estructurado (objetivos, ficheros tocados, comandos, errores, estado actual). Útil cuando el contexto pasa del 70%. El Brain también se resetea y el resumen se persiste en la sesión.
- **Permisos granulares** — nueva tabla `[permissions]` en `sq.toml` con `allow` y `deny` como listas de patrones. Formato: `"Tool"` (cualquier invocación) o `"Tool:pattern"` con glob (`*`). Orden: `deny` > `allow` > pregunta. Ejemplo: `allow = ["Bash:git status*"]`, `deny = ["Bash:rm -rf*"]`.
- **`sq init`** — escanea el proyecto (detecta lenguaje, framework, package manager, scripts) y genera `sq.toml` + `SQUEEZR.md` con plantillas adaptadas. Soporta Node/TypeScript, Python (uv/poetry/pip), Rust, Go.
- **MCP servers (stdio JSON-RPC)** — soporte para Model Context Protocol. Declara servers en `[mcp.<name>]` de `sq.toml` con `command` y `args`; sq los spawnea, hace `initialize` + `tools/list`, merge sus tools con las built-in (con prefijo `<name>:tool`), y enruta `tool_call` al cliente correcto. Timeout 30s por request. Implementación mínima: solo `tools/list` + `tools/call` (no resources, no prompts, no sampling).
  - Ejemplo `sq.toml`:
    ```toml
    [mcp.filesystem]
    command = "npx"
    args = ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"]
    ```

### Changed
- `ToolExecOpts` acepta ahora `rules: PermissionRules` para que las reglas granulares lleguen al executor.
- `SqProxy` expone `setMcpManager()` para inyección del manager tras arrancar los servers en el REPL.
- Renderer gestiona el estado `isThinking` independiente de `isStreaming` para que thinking + text no se solapen visualmente.

### Fixed
- **Doble echo al escribir en el REPL tras `/login`** ("hhoollaa" en vez de "hola"). `readLineFromStdin` solo añadía su propio listener encima del de readline, así que cada tecla la procesaban LOS DOS — readline echaba en cooked mode + nuestro código echaba a mano en raw. Ahora arrancamos los listeners de readline (`'data'` y `'keypress'`) antes de tomar control del stdin y los restauramos intactos al cerrar, mismo patrón que usa el model-picker. El bug de "borro una vez y todo se arregla de golpe" era readline re-renderizando su `rl.line` con el contenido real cuando procesaba el backspace.
- **Texto largo del modelo rompía la barra `│` lateral**. Cuando una línea de la respuesta era más ancha que el terminal, el terminal hacía wrap visual pero la barrita solo aparecía en la primera mitad — la continuación quedaba "colgada" sin prefijo. Nuevo `writeWrapped()` en el renderer hace wrap manual respetando palabras (`\s+` como límite), añadiendo `\n│ ` antes de cada salto para que el bloque se vea alineado a cualquier ancho. Para palabras más anchas que la línea (URLs largas, paths) las trocea a pelo.

## [0.5.8] - 2026-04-17

### Fixed
- **`sq login openai` daba `400 Unknown parameter: 'state'`** en el token exchange. El cuerpo `/v1/oauth/token` de Anthropic exige `state`, pero auth.openai.com lo rechaza explícitamente. Yo lo enviaba siempre desde v0.5.5. Ahora `OAuthConfig.includeStateInTokenRequest` (default false) controla si se incluye o no; Anthropic lo activa, OpenAI/Google se quedan sin él.

## [0.5.7] - 2026-04-17

### Fixed
- **`sq login openai` daba "unknown_error"** de auth.openai.com tras autorizar. El client OAuth de Codex CLI acepta SOLO el redirect_uri exacto `http://localhost:1455/auth/callback` — puerto fijo 1455 y path `/auth/callback`. Yo levantaba un puerto aleatorio en `/callback`, que el authorize aceptaba pero el token endpoint rechazaba. Ahora `OpenAIAuth.login()` pasa `port: 1455` y `redirectPath: '/auth/callback'` al flow.

## [0.5.6] - 2026-04-17

### Fixed
- **El code OAuth pegado se mandaba como prompt al modelo tras `/login anthropic`.** Tras autenticar correctamente, el modelo respondía algo como *"esto parece un token, ¿qué querías?"* — porque el code pegado se filtraba al buffer interno de readline cuando el REPL resumía el control. Causa: en Windows, los pastes vienen en varios chunks; el último puede llegar después de que el flow OAuth ya resolvió pero antes de que readline se reactive, así que se quedaba en el buffer de stdin esperando.
- Dos defensas en cascada:
  1. `readLineFromStdin` instala un listener "tragabyte" durante 50ms tras detectar Enter, que se come cualquier residuo del paste antes de devolver el control.
  2. El handler de `/login` en el REPL drena el buffer de readline (`rl.line = ''`, `rl.cursor = 0`) y vacía el buffer interno de stdin (`process.stdin.read()` en bucle hasta `null`) antes de `rl.resume()`.

## [0.5.5] - 2026-04-17

### Fixed
- **`sq login anthropic` seguía devolviendo "Invalid request format" tras clicar Autorizar** en v0.5.3/5.4. La causa: Claude OAuth exige que el `state` parameter sea literalmente el PKCE `code_verifier`, no un valor aleatorio. Es una rareza no documentada verificada contra [opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth) y el gist de [changjonathanc](https://gist.github.com/changjonathanc/9f9d635b2f8692e0520a884eaf098351). Nueva opción `stateIsVerifier: true` en `OAuthConfig` que anthropic.ts activa. El resto de providers sigue usando state aleatorio (comportamiento OAuth estándar).

## [0.5.4] - 2026-04-17

### Fixed
- **Ctrl+C / Esc no cancelaban el flow de `/login`**. El servidor localhost (Google) y el `readLineFromStdin` (Anthropic, paste manual) bloqueaban la entrada y no había forma de salir sin cerrar el terminal. Ahora ambos modos instalan un listener en stdin en raw mode que aborta al detectar `\x03` (Ctrl+C) o `\x1b` (Esc), cierra el servidor / limpia el listener, y el REPL vuelve al prompt normal.
- **Paste del code con echo visible** — al pegar el code en el flow manual de Anthropic, ahora ves lo que escribes (antes stdin estaba en modo no-raw y el terminal lo oculta en algunos shells). Backspace funciona. Enter confirma. Esc cancela.

## [0.5.3] - 2026-04-17

### Fixed
- **`sq login anthropic` daba "Invalid request format"**. El client OAuth de Claude (`9d1c250a-...`) no acepta `redirect_uri = http://localhost:<port>/callback`. Está registrado contra `https://console.anthropic.com/oauth/code/callback` y exige `code=true` en el authorize URL. Tras autorizar, claude.ai muestra el code en pantalla con formato `<code>#<state>` para que el usuario lo pegue.
  - Nuevo modo `manualCodePaste` en `OAuthConfig`: no levanta servidor localhost, abre navegador, pide al usuario que pegue el code, lo separa por `#` y hace exchange.
  - `tokenRequestFormat: 'json'` añadido (Anthropic exige body JSON con `state` separado, no x-www-form-urlencoded).
- **`@pro` daba 404 en Code Assist** porque los Gemini 3 Pro requieren sufijo de "thinking tier" (`-low` / `-high`). El id pelado `gemini-3.1-pro` no es reconocido — debe ser `gemini-3.1-pro-high` o `gemini-3.1-pro-low`. Fallback hardcoded actualizado al catálogo real de Abril 2026:
  - `gemini-3.1-pro-high` / `gemini-3.1-pro-low` (alias `pro-3.1-high` / `pro-3.1-low`)
  - `gemini-3-pro-high` / `gemini-3-pro-low` (alias `pro-3-high` / `pro-3-low`)
  - `gemini-3-flash` (alias `flash-3`)
  - `gemini-2.5-pro` / `gemini-2.5-flash` (backup para tiers sin acceso a 3.x)
  - `pro` ahora resuelve a `gemini-3.1-pro-high` (el más nuevo + tier alto), `flash` a `gemini-3-flash`.
- **`/v1internal/models` no existe** (devuelve 404). Eliminado el intento de fetch y dejamos solo el fallback hardcoded.

## [0.5.2] - 2026-04-17

### Fixed
- **`@pro` y `/model pro` daban 404 "Requested entity was not found"** del endpoint de Code Assist. El alias resolvía a `gemini-3-pro` porque mi `MIN_GOOGLE_VERSION = [3, 0]` filtraba todo lo demás, pero Gemini 3 no se ha lanzado todavía y Code Assist devuelve 404 para ese id. Bajado el umbral a `[2, 5]` y limpiado el fallback hardcoded para que solo contenga modelos que existen hoy (`gemini-2.5-pro`, `gemini-2.5-flash`). Cuando salga Gemini 3, basta con subir las constantes y restaurar los ids al fallback.
- **Cache obsoleto** — invalida `~/.squeezr-code/models-cache.json` al actualizar (el caché previo con `gemini-3-pro` se queda 1h y dispara el 404 hasta que expira). Si actualizas desde 0.5.1: borra el fichero a mano una vez (`rm ~/.squeezr-code/models-cache.json`) o espera 1h.

## [0.5.1] - 2026-04-17

### Fixed
- **`sq login google` devolvía `Error 401: invalid_client / OAuth client was not found`.** Tres problemas a la vez:
  - El client_id que tenía hardcodeado no era el que usa Gemini CLI (verificado contra `gemini-cli/packages/core/src/code_assist/oauth2.ts`).
  - El client_secret también era de otro proyecto; cambiado al correcto (ver `src/auth/oauth-clients.ts`, no committed).
  - El cliente OAuth de Code Assist exige `redirect_uri = http://127.0.0.1:<port>/oauth2callback` (no `localhost`, no `/callback`). Cualquier desviación → `redirect_uri_mismatch` o `invalid_client`.
- **OAuthConfig** acepta ahora `redirectHost` y `redirectPath` por provider. Default sigue siendo `localhost:<port>/callback`; Google los sobreescribe a los valores que exige Code Assist.
- **Scopes de Google** alineados con gemini-cli: solo `cloud-platform` + `userinfo.email` + `userinfo.profile` (sin `openid`, no está en la consent screen del client OAuth de Code Assist).

## [0.5.0] - 2026-04-17

### Added
- **OAuth flow propio (`sq login` / `/login`)** — sq ya no depende de tener Claude Code / Codex / Gemini CLI instalados para autenticar. Nuevo módulo `src/auth/oauth-flow.ts` con PKCE + servidor HTTP en localhost + apertura de navegador. Cada provider tiene su `login()`:
  - `sq login anthropic`  → claude.ai/oauth/authorize  (`sk-ant-oat...`)
  - `sq login openai`     → auth.openai.com/oauth/authorize  (JWT con `chatgpt_account_id`)
  - `sq login google`     → accounts.google.com/o/oauth2/v2/auth  (refresh_token de Code Assist)
  - Disponible también dentro del REPL como `/login [provider]` (sin argumento → infiere del modelo actual).
- **Prompt inline en `AuthError`** — cuando un request falla por auth expirada, el REPL pregunta `¿reauth con /login google ahora? [Y/n]` y dispara el flow OAuth sin tener que escribir nada. Tras el ✓ basta con reintentar el prompt.
- **Auto-refresh proactivo en background** — timer cada 60s en el REPL que llama a `auth.refreshIfNeeded(2 min)`. Refresca tokens que estén a punto de expirar mientras sq corre, así el primer prompt nunca falla porque acaba de caducar el access_token estando idle.
- **`/cost`** — desglose por modelo en la sesión actual: tokens in/out + USD por modelo + total. Útil para comparar precio real Opus vs Sonnet vs Pro vs Codex en la misma conversación.
- **Persistencia de sesión (`sq resume` / `sq sessions`)** — cada turno se persiste a `~/.squeezr-code/sessions/<id>.json` con historial multi-turn, modelo activo y cwd. `sq resume` reabre la última, `sq resume <id>` una concreta, `sq sessions` lista las guardadas. La sesión se rehidrata en el `SqProxy` y el modelo vuelve al que tenías.
- **Memoria multi-turn real** — antes cada prompt llegaba al modelo sin memoria de los anteriores; el agentic loop solo encadenaba dentro de un mismo prompt. Ahora `SqProxy` mantiene `conversationHistory` entre turnos del REPL. `/clear` lo borra (junto con los contadores del Brain).

### Fixed
- **Refresh OAuth de Google funcionando** — `~/.gemini/oauth_creds.json` solo trae `refresh_token`, no el `client_secret` necesario. Hardcodeamos el client_secret público de Gemini CLI (`GOCSPX-...`) que es por diseño público en OAuth de apps de escritorio. Ahora cuando el access_token caduca, el refresh contra `oauth2.googleapis.com/token` funciona sin tener que abrir Gemini CLI.
- **Mensajes de auth expirado actualizados** — el viejo *"Open Claude Code to refresh it, then run: sq reimport"* (que asumía que tenías el CLI ajeno instalado) pasa a *"Ejecuta /login google en sq para reautenticar"*.

### Changed
- `CommandContext` añade `costByModel` (callback para `/cost`).
- `SqProxy` expone `getConversationHistory()` / `setConversationHistory()` / `onPersist()` para que el REPL persista cada turno.
- `index.ts`: `sq login [provider]` deja de ser un stub y dispara el flow OAuth real.

## [0.4.0] - 2026-04-17

### Added
- **Adapter de Google / Gemini** — sq habla directo con Code Assist API (`cloudcode-pa.googleapis.com/v1internal`), el mismo canal privado que usa `gemini-cli` con login Google. Consume de la suscripción Google AI Pro/Ultra igual que Codex consume ChatGPT Plus y Claude Code consume Claude Pro.
  - REST + SSE sobre `:streamGenerateContent?alt=sse`.
  - Bootstrap de sesión vía `:loadCodeAssist` + `:onboardUser` con polling `done:true` y projectId cacheado en memoria.
  - Traducción bidireccional `NormalizedMessage` ↔ `contents[]` incluyendo `functionCall` / `functionResponse` con tracking de id ↔ name (Gemini no emite id por call).
  - Saneado de schema de tools idéntico al de Anthropic/OpenAI (`required` fuera).
  - `close()` vía `AbortController` (sin listeners que arrancar).
- **`fetchGoogle()` en el catálogo de modelos** con filtro `MIN_GOOGLE_VERSION = [3, 0]` (gemini-3-*). Alias derivados `pro-3.0`, `flash-3.0`. Fallback hardcoded si el tier no expone `/v1internal/models`.
- **Family shortcuts `pro` y `flash`** en el picker y en `resolveModelAlias`. `@pro explica...` resuelve al último Gemini Pro disponible.
- **Comando `/clear`** — borra el contexto del turno actual vía `Brain.reset()`. No toca subscriptions, historial ni auth. Visible en `/help` y autocompletable con TAB.
- **Status bar git-aware** — nuevo `src/repl/git-info.ts` que detecta branch + dirty con `execSync` (timeout 100ms, cache 5s). El prompt muestra `proyecto/branch*`. La caja de bienvenida añade una línea con cwd + branch debajo de auth.

### Changed
- **Formateador de errores** (`src/repl/error-format.ts`) — reemplaza el `Error: {stack}` genérico del catch del REPL con mensajes tipados por `AuthError` / `APIError` / `ENOTFOUND`: "Token rechazado por anthropic (401). reimporta auth con `claude setup-token` y reinicia sq", "Bloqueado por Cloudflare (403). ¿VPN?", "Rate limit. espera 12s o cambia de modelo", etc.
- **README reescrito** — ahora refleja el estado real (3 providers, picker, aliases dinámicos, suscripción % real, tool use, git-aware, `/clear`). La versión anterior se había quedado en v0.1 con solo `claude` + `codex`.
- **`CommandContext.brain`** pasa a ser `{getState, reset}` en lugar de `Brain` entero — acota la superficie y permite que el REPL pase un proxy en vez del Brain real.

## [0.3.2] - 2026-04-17

### Added
- **Indicador 5h / 7d para la suscripción ChatGPT Plus/Pro.** Tras cada respuesta de Codex, sq consulta `https://chatgpt.com/backend-api/codex/usage` (el mismo endpoint que usa Codex CLI) y lo refleja en el status bar y en `/status`. Ahora el `0% 5h · gpt-5.4-mini` es el consumo real de tu Codex, no el de Anthropic.
- **Subscription snapshot por provider.** El Brain ahora guarda un `SubscriptionUsage` separado para anthropic / openai / google. El status bar muestra el del provider del modelo actualmente en uso y cambia al cambiar de modelo. `/status` los imprime todos.

### Fixed
- **El segundo mensaje a Codex no respondía.** Tras la primera petición, el listener `'close'` del socket TLS anterior seguía vivo; cuando el socket se destruía (asíncronamente en la segunda petición) llamaba a `markClosed()` sobre el adapter, marcando el stream nuevo como cerrado antes de que recibiera nada. Se arrancan los listeners antes de destruir el socket.
- **Fetch de `/codex/usage` devolvía 403.** `fetch` de Node (undici) añade `Accept-Encoding: gzip, deflate, br` por defecto y Cloudflare lo rechaza combinado con el UA de Codex. Se reemplaza por `https.request` nativo con control estricto de headers.

## [0.3.1] - 2026-04-17

### Changed
- **Catálogo filtrado por versión mínima**. Solo aparecen modelos Anthropic ≥ 4.5 (Opus 4.7/4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5) y OpenAI ≥ 5.3 (gpt-5.4, gpt-5.4-mini, gpt-5.3-codex). Los umbrales son constantes en `src/api/models.ts`, fáciles de subir cuando salgan nuevas versiones.
- **Default a `sonnet`** (alias dinámico → Sonnet 4.6 hoy). Antes era el ID fijo `claude-sonnet-4-20250514` que dejaba de existir con cada actualización.

### Fixed
- **Picker interactivo aislado de readline** — el picker antiguo compartía canal `keypress` con readline; los ↑↓ pasaban a ambos y al confirmar con Enter el buffer stale de readline reabría el picker silenciosamente con el modelo por defecto. Ahora el picker remueve temporalmente los listeners de readline, usa bytes crudos en `data`/rawMode, y los restaura intactos al cerrar.
- **Modelos OpenAI visibles en el picker** — el parser buscaba `m.id` pero el cache de Codex usa `m.slug`. Se añade `slug` como primer fallback.
- **Glitch visual "Elige modelo Elige modelo…"** al redibujar con líneas largas — ahora se guarda la posición del cursor con `\x1b[s` al abrir y se restaura con `\x1b[u\x1b[J` en cada redibujo.
- **Race en `/model` al arrancar** — `loadModels()` corría en background; un `@alias` inmediato llegaba con catálogo vacío. Ahora `await` antes del primer prompt.
- **Fallback de `providerForModel`** — aliases que empiezan por dígito (`5.4-mini`) se rutan a OpenAI en lugar de caer en Anthropic por defecto.

## [0.3.0] - 2026-04-17

### Added
- **Adapter de OpenAI / Codex** — sq habla directamente con `wss://chatgpt.com/backend-api/codex/responses` usando el OAuth token importado de `~/.codex/auth.json`. Mismo canal que usa Codex CLI, por tanto consume de la misma suscripción ChatGPT Plus/Pro.
  - Implementación zero-deps: handshake HTTP/1.1 Upgrade + frames WebSocket (RFC 6455) escritos a mano sobre `tls` nativo.
  - Traducción bidireccional entre el `NormalizedMessage` de sq y el protocolo `response.*` de Codex (`response.create`, `response.output_text.delta`, `response.function_call_arguments.*`, `response.completed`).
  - Soporte para function-calling (tool_use) con saneado de schema JSON Schema draft 2020-12.
  - Refresh automático del access_token contra `https://auth.openai.com/oauth/token` cuando expira.
- **Modelos de Codex en el picker** — se leen de `~/.codex/models_cache.json`, por tanto aparecen los reales de tu cuenta: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5-codex`, etc.

### Changed
- El header del turno ya no muestra el nombre del modelo (`opus` / `sonnet`) — pone `Squeezr`. El modelo sigue visible en el status bar inferior.

## [0.2.0] - 2026-04-17

### Added
- **Selector interactivo de modelo** — `/model` sin argumentos abre un picker con ↑↓ + Enter/Esc.
- **Fetch dinámico de modelos** — Al arrancar, sq llama a `/v1/models` de cada provider autenticado y cachea 1h en `~/.squeezr-code/models-cache.json`. Ya no hay IDs hardcoded que caducan; Opus 4.7 / Sonnet 4.6 / etc. aparecen solos.
- **Alias dinámicos** — `opus`, `sonnet`, `haiku` apuntan siempre al último de la familia (Opus 4.7, Sonnet 4.6, Haiku 4.5). También se derivan aliases versionados como `opus-4.7`, `sonnet-4.6`.
- **Spinner durante la llamada a la API** — rellena el hueco silencioso entre request y primer token; también mientras corren las tools.
- **Historial persistente** — `~/.squeezr-code/history`, 500 entradas, navegable con ↑/↓ entre sesiones.
- **Autocompletado con TAB** — comandos (`/he<TAB>` → `/help`), aliases de modelo y `@alias`.
- **Banner SQUEEZR CODE** con gradiente azul→cian y caja estilo Claude Code al arrancar.
- **Bloques visuales por turno** — cada respuesta va enmarcada con `│` a la izquierda y se cierra con `╰──`, similar al output de Claude Code.
- **% real de la suscripción Claude** — el status bar muestra `3% 5h` (utilización real de la ventana de 5h) en lugar del % de contexto sintético anterior. Datos leídos de los headers `anthropic-ratelimit-unified-*` en cada respuesta.
- **`/status` extendido** — muestra ventana 5h%, 7d%, 7d (sonnet)%, y cuándo resetean.

### Fixed
- **OAuth de Claude Code funcionando** — los tokens `sk-ant-oat...` importados de `~/.claude/.credentials.json` ahora son aceptados por `api.anthropic.com`. Se añade el header obligatorio `anthropic-beta: oauth-2025-04-20` y se envía el `system` prompt como array con la preamble `"You are Claude Code, Anthropic's official CLI for Claude."` que la API exige para OAuth.
- **Schemas de tool válidos JSON Schema draft 2020-12** — se elimina el campo `required: true` que estaba dentro de cada property (Anthropic ahora valida estricto y devolvía 400). Los nombres requeridos se agregan al array `required` del schema raíz.
- **% de contexto correcto** — antes acumulaba `input_tokens` de cada turno, contando el historial N veces. Ahora muestra la ocupación real de la ventana (último turno) mientras que totales y coste siguen acumulando.

### Changed
- Iconos de tool en el renderer cambiados a caracteres tipográficos Unicode (`▸ ✎ ± $ * ⌕`) en lugar de emojis.
- `/model list` imprime la lista completa sin abrir el picker.

## [0.1.0] - 2026-04-12

### Added
- REPL inicial con agentic loop propio (no wrapper de Claude Code CLI).
- Adapter Anthropic con streaming SSE.
- Importación automática de tokens desde Claude Code, Codex CLI y Gemini CLI.
- Tools: Read, Write, Edit, Bash, Glob, Grep.
- Comando `sq doctor` para comprobar auth + proxy.
- Configuración vía `sq.toml` y `~/.squeezr-code/config.toml`.

[Unreleased]: https://github.com/sergioramosv/squeezr-code/compare/v0.15.2...HEAD
[0.15.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.15.2
[0.15.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.15.1
[0.15.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.15.0
[0.14.8]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.8
[0.14.7]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.7
[0.14.6]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.6
[0.14.5]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.5
[0.14.4]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.4
[0.14.3]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.3
[0.14.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.2
[0.14.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.1
[0.14.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.14.0
[0.13.4]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.13.4
[0.13.3]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.13.3
[0.13.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.13.2
[0.13.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.13.1
[0.13.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.13.0
[0.12.4]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.12.4
[0.12.3]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.12.3
[0.12.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.12.2
[0.12.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.12.1
[0.12.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.12.0
[0.11.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.11.2
[0.11.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.11.1
[0.11.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.11.0
[0.10.5]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.10.5
[0.10.4]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.10.4
[0.10.3]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.10.3
[0.10.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.10.2
[0.10.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.10.1
[0.10.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.10.0
[0.5.8]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.8
[0.5.7]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.7
[0.5.6]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.6
[0.5.5]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.5
[0.5.4]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.4
[0.5.3]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.3
[0.5.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.2
[0.5.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.1
[0.5.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.5.0
[0.4.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.4.0
[0.3.2]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.3.2
[0.3.1]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.3.1
[0.3.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.3.0
[0.2.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.2.0
[0.1.0]: https://github.com/sergioramosv/squeezr-code/releases/tag/v0.1.0

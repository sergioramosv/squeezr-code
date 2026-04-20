/**
 * ink-repl.ts — Entry point for the Ink-based REPL (Phase 2).
 *
 * Responsibilities:
 *  - Auth + model loading
 *  - SqAgent construction
 *  - MCP setup (optional, background)
 *  - Session persistence hooks
 *  - Render <App> via ink
 *
 * All terminal rendering is handled by ink-app.tsx. This file stays minimal.
 */

import React from 'react'
import { render } from 'ink'
import { App } from './ink-app.js'
import { SqAgent } from '../agent/agent.js'
import { AuthManager } from '../auth/manager.js'
import { loadModels } from '../api/models.js'
import { Session } from '../state/session.js'
import { McpManager } from '../mcp/manager.js'
import type { SqConfig } from '../config.js'
import path from 'node:path'
import { getVersion } from '../version.js'
import { loadCustomCommands, installBuiltinSkills, type CustomCommand } from './custom-commands.js'

export async function startInkRepl(config: SqConfig, opts?: { resumeSession?: Session }): Promise<void> {
  const cwd = process.cwd()
  const projectName = path.basename(cwd)

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = new AuthManager()
  const authStatus = await auth.init()

  // Load models catalogue (best-effort — non-fatal if offline)
  await loadModels(auth, authStatus).catch(() => [])

  // ── Agent ─────────────────────────────────────────────────────────────────
  const agent = new SqAgent(auth, {
    defaultModel: config.agent.default,
    permissions: config.agent.permissions,
    rules: config.permissions,
    sandbox: config.sandbox,
    transplant: {
      warnThreshold: config.transplant.warn_threshold,
      autoThreshold: config.transplant.auto_threshold,
    },
  })

  // ── Session persistence ───────────────────────────────────────────────────
  const session = opts?.resumeSession ?? Session.create({ cwd, model: agent.getCurrentModel() })

  // If resuming, restore conversation history and model into the agent
  let resumedInfo: { sessionId: string; turns: number } | undefined
  if (opts?.resumeSession) {
    const resumed = opts.resumeSession
    agent.setConversationHistory(resumed.getMessages())
    agent.setModel(resumed.getModel())
    const turns = resumed.getMessages().filter(m => m.role === 'user').length
    resumedInfo = { sessionId: resumed.getId(), turns }

    // Auto-compact if history is large (> 100KB)
    if (agent.historyChars() > 100_000) {
      process.stderr.write('  ▸ session history is large — compacting before start…\n')
      try {
        for await (const _ev of agent.compact()) { /* silent */ }
        process.stderr.write('  ✓ compacted\n')
      } catch { /* best-effort */ }
    }
  }

  agent.onPersist(messages => session.updateMessages(messages))

  // ── MCP (background, non-fatal) ───────────────────────────────────────────
  const mcp = new McpManager()
  const mcpSpecs = Object.entries(config.mcp || {}).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args,
    env: spec.env,
  }))
  if (mcpSpecs.length > 0) {
    // Fire-and-forget: servers connect in background, REPL starts immediately.
    mcp.start(mcpSpecs)
  }
  agent.setMcpManager(mcp)

  // ── Skills (custom commands) ──────────────────────────────────────────────
  installBuiltinSkills()
  const customCommands = loadCustomCommands(cwd)

  // ── Render ────────────────────────────────────────────────────────────────
  const app = render(
    React.createElement(App, {
      agent,
      config,
      cwd,
      projectName,
      resumedInfo,
      version: getVersion(),
      authStatus,
      customCommands,
    }),
  )

  await app.waitUntilExit()
  agent.shutdown()
}

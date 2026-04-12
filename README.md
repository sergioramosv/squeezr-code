# squeezr-code

> The intelligent CLI that never loses context.

`sq` is an interactive CLI agent that talks directly to Anthropic, OpenAI, and Google APIs through the [squeezr-ai](https://github.com/sergioramosv/squeezr-ai) compression proxy. It's its own agent — not a wrapper around other CLIs.

## Features

- **Direct API calls** to Claude, Codex (ChatGPT), and Gemini via OAuth subscriptions
- **Own agentic loop** with tools: Read, Write, Edit, Bash, Glob, Grep
- **Token import** from Claude Code, Codex CLI, and Gemini CLI (zero config)
- **Context tracking** with transplant support for infinite sessions
- **Cost tracking** with budget enforcement
- **Multi-model routing** (coming soon)

## Install

```bash
npm install -g squeezr-code
```

## Quick start

```bash
# Check auth & proxy status
sq doctor

# Start interactive REPL
sq

# Use a specific model
sq --model opus
```

## Auth

sq imports OAuth tokens from existing CLIs automatically:

```
~/.claude/.credentials.json  → Anthropic
~/.codex/auth.json           → OpenAI
~/.gemini/oauth_creds.json   → Google
```

Tokens are copied to `~/.squeezr-code/auth/` on first use. Re-import with:

```bash
sq reimport
```

## Commands

| Command | Description |
|---|---|
| `/model <name>` | Switch model (opus, sonnet, haiku, o3, gemini-pro...) |
| `/status` | Show context %, model, cost |
| `/help` | List commands |
| `/exit` | Exit |
| `@model prompt` | One-off model override |

## Requirements

- Node.js >= 18
- [squeezr-ai](https://github.com/sergioramosv/squeezr-ai) proxy running
- At least one authenticated provider (Claude Code, Codex, or Gemini CLI)

## License

MIT

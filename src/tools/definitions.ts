import type { ToolDef } from '../api/types.js'

export const SQ_TOOLS: ToolDef[] = [
  {
    name: 'Read',
    description: 'Read a file from the filesystem. Returns numbered lines for text files. Supports PDF (.pdf) extraction — for PDFs > 10 pages, pass `pages` with a range like "1-5" (max 20 pages per call).',
    parameters: {
      file_path: { type: 'string', description: 'Absolute path to the file', required: true },
      offset: { type: 'number', description: 'Start line (0-based) — text files only' },
      limit: { type: 'number', description: 'Max lines to read (default 2000) — text files only' },
      pages: { type: 'string', description: 'Page range for PDFs (e.g. "1-5", "3", "10-20"). Max 20 pages per call.' },
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file (creates directories if needed, overwrites existing)',
    parameters: {
      file_path: { type: 'string', description: 'Absolute path', required: true },
      content: { type: 'string', description: 'File content', required: true },
    },
  },
  {
    name: 'Edit',
    description: 'Replace a string in a file. By default old_string must appear exactly once. Use replace_all=true to replace every occurrence.',
    parameters: {
      file_path: { type: 'string', description: 'Absolute path', required: true },
      old_string: { type: 'string', description: 'Exact text to find', required: true },
      new_string: { type: 'string', description: 'Replacement text', required: true },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command and return stdout + stderr. Use run_in_background=true for long-running processes (returns shell_id; check with BashOutput, kill with KillShell).',
    parameters: {
      command: { type: 'string', description: 'The command to run', required: true },
      description: { type: 'string', description: 'Short description of what the command does (5-10 words)' },
      timeout: { type: 'number', description: 'Timeout in ms (default 120000, max 600000)' },
      run_in_background: { type: 'boolean', description: 'Run in background and return shell_id immediately' },
    },
  },
  {
    name: 'BashOutput',
    description: 'Read the current output of a background bash process started with run_in_background. Returns stdout + stderr captured so far + status.',
    parameters: {
      shell_id: { type: 'string', description: 'shell_id returned by Bash(run_in_background=true)', required: true },
    },
  },
  {
    name: 'KillShell',
    description: 'Stop a background bash process. Sends SIGTERM, then SIGKILL after 2s if still alive.',
    parameters: {
      shell_id: { type: 'string', description: 'shell_id to kill', required: true },
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch a URL and return its content as markdown. Handles redirects and converts HTML.',
    parameters: {
      url: { type: 'string', description: 'Full URL to fetch (https:// preferred)', required: true },
      prompt: { type: 'string', description: 'Optional question about the content' },
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web (DuckDuckGo) and return top results. No API key needed.',
    parameters: {
      query: { type: 'string', description: 'Search query (min 2 chars)', required: true },
      allowed_domains: { type: 'array', description: 'Only return results from these domains', items: { type: 'string' } },
      blocked_domains: { type: 'array', description: 'Exclude results from these domains', items: { type: 'string' } },
    },
  },
  {
    name: 'TaskCreate',
    description: 'Create a task in the session task list. Use to track multi-step work.',
    parameters: {
      subject: { type: 'string', description: 'Brief title (imperative form)', required: true },
      description: { type: 'string', description: 'Detailed requirements' },
      activeForm: { type: 'string', description: 'Present continuous shown when in_progress (e.g. "Running tests")' },
    },
  },
  {
    name: 'TaskList',
    description: 'List all tasks in the session with status and id.',
    parameters: {},
  },
  {
    name: 'TaskGet',
    description: 'Get full details (subject, description, status, blockedBy/blocks) of a task by id.',
    parameters: {
      taskId: { type: 'string', description: 'Task id', required: true },
    },
  },
  {
    name: 'TaskUpdate',
    description: 'Update a task: change status (pending/in_progress/completed/deleted), subject, description, or dependencies.',
    parameters: {
      taskId: { type: 'string', description: 'Task id', required: true },
      status: { type: 'string', description: 'pending | in_progress | completed | deleted' },
      subject: { type: 'string' },
      description: { type: 'string' },
      activeForm: { type: 'string' },
      addBlockedBy: { type: 'array', items: { type: 'string' }, description: 'Task ids that block this' },
      addBlocks: { type: 'array', items: { type: 'string' }, description: 'Task ids this blocks' },
    },
  },
  {
    name: 'AskUserQuestion',
    description: 'Pause and ask the user a multiple-choice question. Returns the selected answer.',
    parameters: {
      question: { type: 'string', description: 'The question to ask', required: true },
      options: { type: 'array', description: 'Array of {label, description} objects (2-4 options)', items: { type: 'object' }, required: true },
      multiSelect: { type: 'boolean', description: 'Allow multiple selections (default false)' },
    },
  },
  {
    name: 'NotebookEdit',
    description: 'Edit a Jupyter .ipynb notebook cell. Modes: replace (default), insert, delete.',
    parameters: {
      notebook_path: { type: 'string', description: 'Absolute path to the .ipynb file', required: true },
      new_source: { type: 'string', description: 'New cell content (required for replace/insert)' },
      cell_id: { type: 'string', description: 'Cell id to target (preferred)' },
      cell_number: { type: 'number', description: 'Cell index (0-based, fallback if no cell_id)' },
      edit_mode: { type: 'string', description: 'replace | insert | delete (default: replace)' },
      cell_type: { type: 'string', description: 'code | markdown (required for insert)' },
    },
  },
  {
    name: 'Task',
    description: 'Spawn a sub-agent with a focused task. Returns the final text. Useful for parallel research, isolating long-context exploration, or specialized work. **Multiple Task calls in one response run IN PARALLEL** — sq batches them via Promise.all, so `Task(A) + Task(B) + Task(C)` = 3 agents working simultaneously. Each can use a different model via the `model` param: `Task(model="haiku", ...)` for fast/cheap, `Task(model="opus", ...)` for deep analysis, `Task(model="gemini-pro", ...)` for alternative perspective. Mix providers freely.\n\n`subagent_type` loads a predefined agent from ~/.squeezr-code/agents/<name>.md (its own system prompt + model + tools). `model` inline overrides whatever the subagent_type defined.',
    parameters: {
      description: { type: 'string', description: 'Short description (3-5 words) shown in UI', required: true },
      prompt: { type: 'string', description: 'Full task for the sub-agent', required: true },
      subagent_type: { type: 'string', description: 'Optional: name of a predefined agent from ~/.squeezr-code/agents/<name>.md.' },
      model: { type: 'string', description: 'Optional: model alias for this sub-agent (haiku / sonnet / opus / gpt-5 / gpt-5-codex / gemini-pro / gemini-flash). Override. Provider se infiere del alias.' },
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.ts")',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern', required: true },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with ripgrep-style regex. Three output modes (files_with_matches, content, count). Multiline patterns supported.',
    parameters: {
      pattern: { type: 'string', description: 'Regex pattern', required: true },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
      glob: { type: 'string', description: 'File filter glob (e.g. "*.ts", "**/*.{js,ts}")' },
      output_mode: { type: 'string', description: '"files_with_matches" (default), "content" (lines), "count" (per-file count)' },
      '-i': { type: 'boolean', description: 'Case insensitive' },
      '-n': { type: 'boolean', description: 'Show line numbers (only in content mode)' },
      '-A': { type: 'number', description: 'Lines AFTER each match (content mode)' },
      '-B': { type: 'number', description: 'Lines BEFORE each match (content mode)' },
      '-C': { type: 'number', description: 'Lines around each match (content mode)' },
      multiline: { type: 'boolean', description: 'Allow patterns to span multiple lines (. matches \\n)' },
      head_limit: { type: 'number', description: 'Max lines/entries to return (default 250)' },
    },
  },
  {
    name: 'CronCreate',
    description: 'Schedule a prompt to fire at a future time. Standard 5-field cron in local timezone: "M H DoM Mon DoW". Recurring by default; set recurring=false for one-shot.\n\nExamples:\n- "*/5 * * * *" → every 5 minutes\n- "0 9 * * 1-5" → weekdays at 9am\n- "30 14 28 2 *" → Feb 28 at 2:30pm once (with recurring=false)\n\nRecurring jobs auto-expire after 7 days. Jobs fire only while the REPL is idle.',
    parameters: {
      cron: { type: 'string', description: 'Cron spec: "M H DoM Mon DoW"', required: true },
      prompt: { type: 'string', description: 'The prompt to inject when the job fires', required: true },
      recurring: { type: 'boolean', description: 'true (default) = fire until expiry. false = fire once.' },
      durable: { type: 'boolean', description: 'true = persist to disk and survive restarts. false (default) = in-memory only.' },
    },
  },
  {
    name: 'CronList',
    description: 'List all scheduled cron jobs.',
    parameters: {},
  },
  {
    name: 'CronDelete',
    description: 'Cancel a scheduled cron job by its id.',
    parameters: {
      id: { type: 'string', description: 'Job id returned by CronCreate', required: true },
    },
  },
  {
    name: 'EnterWorktree',
    description: 'Create an isolated git worktree under `.claude/worktrees/<name>/` on a new branch, and switch the REPL cwd into it. Use this when the user asks to work in a worktree or parallel branch without affecting the main checkout.\n\nPass `name` to create a new worktree (default: auto-generated). Pass `path` instead to enter an existing worktree of this repo. Call `ExitWorktree` when done.',
    parameters: {
      name: { type: 'string', description: 'Name for the new worktree. letters, digits, ., _, -, /, max 64 chars.' },
      path: { type: 'string', description: 'Path of an existing worktree to switch into. Mutually exclusive with name.' },
    },
  },
  {
    name: 'ExitWorktree',
    description: 'Leave the currently active worktree. Pass action="keep" to leave the worktree on disk (come back later), or action="remove" to delete it + its branch cleanly. With "remove", uncommitted changes are refused unless you pass discard_changes=true.',
    parameters: {
      action: { type: 'string', description: '"keep" or "remove"', required: true },
      discard_changes: { type: 'boolean', description: 'Required true when action=remove and there are uncommitted changes.' },
    },
  },
  {
    name: 'Monitor',
    description: 'Run a shell command and collect matching lines. Use for builds/tests/log-watching where you want to capture specific output. Runs up to `timeout_ms` or until the process exits. Lines from stdout+stderr are filtered by optional regex. Returns a summary with matched lines.\n\nExamples:\n- Build: Monitor({ command: "npm run build", timeout_ms: 120000, filter: "error|FAIL" })\n- Tests: Monitor({ command: "npm test", filter: "FAIL|✗" })\n- Logs: Monitor({ command: "tail -n 500 app.log", filter: "ERROR" })',
    parameters: {
      command: { type: 'string', description: 'Shell command to run', required: true },
      description: { type: 'string', description: 'Short human-readable description (shown in result header)' },
      timeout_ms: { type: 'number', description: 'Kill after this many ms. Default 60000, max 600000.' },
      filter: { type: 'string', description: 'Regex to match lines from stdout+stderr. If omitted, captures all lines.' },
    },
  },
  {
    name: 'ExitPlanMode',
    description: 'ONLY available when the user set permissions to plan mode. Call this to present your implementation plan to the user and request approval before writing any code. Pass the full plan as `plan` (markdown). If approved, the session switches to accept-edits mode automatically. If rejected, you stay in plan mode.',
    parameters: {
      plan: { type: 'string', description: 'The full implementation plan in markdown. Include goals, files to modify, step-by-step actions.', required: true },
    },
  },
]

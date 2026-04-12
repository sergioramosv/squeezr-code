import type { ToolDef } from '../api/types.js'

export const SQ_TOOLS: ToolDef[] = [
  {
    name: 'Read',
    description: 'Read a file from the filesystem. Returns numbered lines.',
    parameters: {
      file_path: { type: 'string', description: 'Absolute path to the file', required: true },
      offset: { type: 'number', description: 'Start line (0-based)' },
      limit: { type: 'number', description: 'Max lines to read (default 2000)' },
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
    description: 'Replace a unique string in a file. old_string must appear exactly once.',
    parameters: {
      file_path: { type: 'string', description: 'Absolute path', required: true },
      old_string: { type: 'string', description: 'Exact text to find (must be unique)', required: true },
      new_string: { type: 'string', description: 'Replacement text', required: true },
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command and return stdout + stderr',
    parameters: {
      command: { type: 'string', description: 'The command to run', required: true },
      timeout: { type: 'number', description: 'Timeout in ms (default 120000)' },
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
    description: 'Search file contents with regex. Returns matching lines with file paths and line numbers.',
    parameters: {
      pattern: { type: 'string', description: 'Regex pattern', required: true },
      path: { type: 'string', description: 'Directory to search in (default: cwd)' },
      glob: { type: 'string', description: 'File filter glob (e.g. "*.ts")' },
    },
  },
]

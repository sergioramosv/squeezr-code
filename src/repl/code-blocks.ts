/**
 * Extract fenced code blocks from a markdown string.
 *
 * Only parses triple-backtick (```) fences — that's what the agent uses.
 * Optional language on the open fence is captured so a future UI can
 * show it ("copy bash block", "copy typescript block", …).
 *
 * Heuristic for "no fences at all, but the message is clearly code":
 * if the whole message (trimmed) has no backticks and starts with a
 * shell prompt-ish first line (e.g. `$ npm …`, `npm i …`, `git …`), we
 * treat the whole message as one implicit block. Kept intentionally
 * conservative to avoid copying narrative prose when the user asked for
 * an explanation.
 */
export interface CodeBlock {
  lang: string | null
  code: string
}

const FENCED = /```([^\n`]*)\n([\s\S]*?)```/g

export function extractCodeBlocks(md: string): CodeBlock[] {
  if (!md) return []
  const blocks: CodeBlock[] = []
  let m: RegExpExecArray | null
  FENCED.lastIndex = 0
  while ((m = FENCED.exec(md)) !== null) {
    const lang = m[1].trim() || null
    const code = m[2].replace(/\n$/, '') // trim single trailing newline, keep intentional blank lines
    if (code.length > 0) blocks.push({ lang, code })
  }
  return blocks
}

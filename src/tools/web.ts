/**
 * WebFetch — descarga una URL y la convierte en texto markdown plano para que
 * el modelo pueda leerla. Implementación zero-dep: fetch nativo + regex naive
 * para HTML → markdown. No es perfecto pero cubre el 90% de casos (artículos,
 * docs, READMEs renderizados).
 *
 * WebSearch — usa el HTML de DuckDuckGo (`html.duckduckgo.com/html/`) para
 * sacar los primeros N resultados. Sin API key, sin rate limit visible. Si DDG
 * cambia el HTML el parser se rompe — fallback a "no results".
 */

const MAX_BYTES = 1_500_000  // 1.5MB de HTML máximo
const MAX_OUTPUT = 30_000    // tras conversión, recortamos a 30k chars

const UA = 'Mozilla/5.0 (squeezr-code) AppleWebKit/537.36'

export async function webFetch(input: Record<string, unknown>): Promise<string> {
  const url = input.url as string
  const prompt = input.prompt as string | undefined
  if (!url) return 'Error: url is required'

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!res.ok) {
    return `Error: ${res.status} ${res.statusText} fetching ${url}`
  }

  // Detectar redirect a otro host (Claude Code lo hace explícito)
  const finalUrl = res.url
  if (new URL(finalUrl).host !== new URL(url).host) {
    return `[REDIRECT] ${url} → ${finalUrl}\nRequest WebFetch again with the new URL.`
  }

  const contentType = res.headers.get('content-type') || ''
  let text = await readBoundedText(res)
  if (text.length === 0) return `(empty body from ${url})`

  // HTML → markdown plano. Otros tipos (json, text/plain) los dejamos crudos.
  if (/html|xml/i.test(contentType) || text.trim().startsWith('<')) {
    text = htmlToMarkdown(text)
  }

  if (text.length > MAX_OUTPUT) {
    text = text.slice(0, MAX_OUTPUT) + '\n\n... (truncated)'
  }

  if (prompt) {
    return `# ${url}\n\n${text}\n\n---\nUser prompt: ${prompt}\n(El modelo debe responder al prompt usando el contenido de arriba.)`
  }
  return `# ${url}\n\n${text}`
}

export async function webSearch(input: Record<string, unknown>): Promise<string> {
  const query = input.query as string
  if (!query) return 'Error: query is required'
  const allowed = (input.allowed_domains as string[] | undefined) || []
  const blocked = (input.blocked_domains as string[] | undefined) || []

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return `Error de búsqueda: ${err instanceof Error ? err.message : String(err)}`
  }
  if (!res.ok) return `Error de búsqueda: ${res.status} ${res.statusText}`

  const html = await readBoundedText(res)
  const results = parseDuckDuckGoResults(html)
    .filter(r => allowed.length === 0 || allowed.some(d => r.url.includes(d)))
    .filter(r => !blocked.some(d => r.url.includes(d)))
    .slice(0, 10)

  if (results.length === 0) return `Sin resultados para: ${query}`

  const lines: string[] = [`# Resultados para: ${query}`, '']
  for (const r of results) {
    lines.push(`- [${r.title}](${r.url})`)
    if (r.snippet) lines.push(`  ${r.snippet}`)
  }
  lines.push('')
  lines.push(`Sources:`)
  for (const r of results) lines.push(`- [${r.title}](${r.url})`)
  return lines.join('\n')
}

async function readBoundedText(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    if (total >= MAX_BYTES) {
      try { reader.cancel() } catch { /* ignore */ }
      break
    }
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8')
}

function htmlToMarkdown(html: string): string {
  // Quita script/style enteros
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
  html = html.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
  html = html.replace(/<!--[\s\S]*?-->/g, '')

  // Headings
  html = html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n\n')
  html = html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n\n')
  html = html.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n\n')
  html = html.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n#### $1\n\n')

  // Links
  html = html.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')

  // Bold/italic
  html = html.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  html = html.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')

  // Code
  html = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n')
  html = html.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')

  // Lists
  html = html.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')

  // Paragraphs / breaks
  html = html.replace(/<\/p>/gi, '\n\n')
  html = html.replace(/<br\s*\/?>/gi, '\n')

  // Strip remaining tags
  html = html.replace(/<[^>]+>/g, '')

  // Decode entities básicos
  html = html
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)))

  // Colapsa whitespace
  html = html.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
  return html.trim()
}

interface SearchResult { title: string; url: string; snippet: string }
function parseDuckDuckGoResults(html: string): SearchResult[] {
  const out: SearchResult[] = []
  // DDG HTML usa class="result" o "result__body"
  const blockRe = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1]
    const linkM = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkM) continue
    let url = linkM[1]
    // DDG envuelve URLs en /l/?uddg=... — extraemos el target real
    const ddgM = url.match(/uddg=([^&]+)/)
    if (ddgM) url = decodeURIComponent(ddgM[1])
    const title = stripTags(linkM[2])
    const snipM = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    const snippet = snipM ? stripTags(snipM[1]) : ''
    out.push({ title, url, snippet })
  }
  return out
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

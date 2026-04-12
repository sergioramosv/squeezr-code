import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export async function isProxyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function tryStartProxy(): Promise<boolean> {
  try {
    // Try starting squeezr-ai in background
    await execAsync('squeezr start', { timeout: 10_000 })
    // Wait a bit for it to be ready
    await new Promise(r => setTimeout(r, 2000))
    return true
  } catch {
    return false
  }
}

export async function ensureProxy(port: number): Promise<{ running: boolean; message: string }> {
  if (await isProxyRunning(port)) {
    return { running: true, message: `Proxy running on :${port}` }
  }

  // Try auto-start
  const started = await tryStartProxy()
  if (started && await isProxyRunning(port)) {
    return { running: true, message: `Proxy auto-started on :${port}` }
  }

  return {
    running: false,
    message: `Proxy not running on :${port}. Run: squeezr start`,
  }
}

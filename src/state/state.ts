import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SQ_HOME = path.join(os.homedir(), '.squeezr-code')

export function ensureSqHome(): void {
  const dirs = [
    SQ_HOME,
    path.join(SQ_HOME, 'auth'),
    path.join(SQ_HOME, 'sessions'),
    path.join(SQ_HOME, 'projects'),
    path.join(SQ_HOME, 'economist'),
    path.join(SQ_HOME, 'economist', 'daily'),
  ]
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function getSqHome(): string {
  return SQ_HOME
}

export function getSessionsDir(): string {
  return path.join(SQ_HOME, 'sessions')
}

export function getProjectsDir(): string {
  return path.join(SQ_HOME, 'projects')
}

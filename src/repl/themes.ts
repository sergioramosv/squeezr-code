/**
 * Themes para el REPL. Tabla de colores intercambiable.
 *
 * Configurado en sq.toml:
 *   [display]
 *   theme = "dark" | "light" | "solarized" | "nord"
 */

export interface Theme {
  primary: string   // headings, accents
  secondary: string // status bar, dim labels
  success: string
  warning: string
  error: string
  user: string      // mensaje del usuario
  assistant: string // mensaje del modelo
  bar: string       // barra │ lateral
}

const RESET = '\x1b[0m'

const DARK: Theme = {
  primary: '\x1b[36m',
  secondary: '\x1b[2m',
  success: '\x1b[32m',
  warning: '\x1b[33m',
  error: '\x1b[31m',
  user: '\x1b[37m',
  assistant: '\x1b[37m',
  bar: '\x1b[90m',
}

const LIGHT: Theme = {
  primary: '\x1b[34m',
  secondary: '\x1b[2m',
  success: '\x1b[32m',
  warning: '\x1b[33m',
  error: '\x1b[31m',
  user: '\x1b[30m',
  assistant: '\x1b[30m',
  bar: '\x1b[37m',
}

const SOLARIZED: Theme = {
  primary: '\x1b[38;5;33m',
  secondary: '\x1b[38;5;240m',
  success: '\x1b[38;5;64m',
  warning: '\x1b[38;5;136m',
  error: '\x1b[38;5;160m',
  user: '\x1b[38;5;245m',
  assistant: '\x1b[38;5;245m',
  bar: '\x1b[38;5;240m',
}

const NORD: Theme = {
  primary: '\x1b[38;5;110m',
  secondary: '\x1b[38;5;243m',
  success: '\x1b[38;5;108m',
  warning: '\x1b[38;5;179m',
  error: '\x1b[38;5;167m',
  user: '\x1b[38;5;188m',
  assistant: '\x1b[38;5;188m',
  bar: '\x1b[38;5;243m',
}

const THEMES: Record<string, Theme> = {
  dark: DARK,
  light: LIGHT,
  solarized: SOLARIZED,
  nord: NORD,
}

let active: Theme = DARK

export function setTheme(name: string): void {
  active = THEMES[name] || DARK
}

export function theme(): Theme { return active }
export { RESET }

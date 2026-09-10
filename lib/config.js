/**
 * Configuration for the strict gate.
 *
 * @module @dsh-external/dsh-policy-strict-gate/config
 */

/** Fully resolved, always-total configuration. */
export const DEFAULTS = Object.freeze({
  /** Globs for the protected tree. Empty disables the critical-path gate. */
  criticalPaths: [],
  /** Tools whose calls are treated as writes. */
  protectedTools: ['write', 'edit', 'str_replace_editor'],
  /** Identical signatures before the repeat notice. */
  repeatThreshold: 3,
  /** After the first notice, speak again every this many repeats. */
  repeatCooldown: 3,
  /** Check a file with its language's compiler right after a write. */
  postWriteSyntax: true,
  /** Diagnostics quoted in one message. */
  maxDiagnostics: 5,
  /** Per-check wall clock. */
  timeoutMs: 60_000,
  /** Register `strict_gate_status`. */
  exposeStatusTool: true,
})

/** Read a positive integer, falling back to the default. */
function intOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

/** Read a boolean-ish value, falling back to the default. */
function boolOr(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === '1' || text === 'on') return true
  if (text === 'false' || text === 'no' || text === '0' || text === 'off') return false
  return fallback
}

/** Read a list of non-empty strings. */
function strings(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const list = value.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
  return list
}

/**
 * Resolve raw profile config into a total configuration object.
 * @param raw - the `config:` block of the plugin row, or undefined.
 * @returns every field present and validated.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    criticalPaths: strings(source.criticalPaths, DEFAULTS.criticalPaths),
    protectedTools: strings(source.protectedTools, DEFAULTS.protectedTools),
    repeatThreshold: intOr(source.repeatThreshold, DEFAULTS.repeatThreshold),
    repeatCooldown: intOr(source.repeatCooldown, DEFAULTS.repeatCooldown),
    postWriteSyntax: boolOr(source.postWriteSyntax, DEFAULTS.postWriteSyntax),
    maxDiagnostics: intOr(source.maxDiagnostics, DEFAULTS.maxDiagnostics),
    timeoutMs: intOr(source.timeoutMs, DEFAULTS.timeoutMs),
    exposeStatusTool: boolOr(source.exposeStatusTool, DEFAULTS.exposeStatusTool),
  }
}

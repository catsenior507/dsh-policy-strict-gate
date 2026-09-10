/**
 * Failure signatures and their remediation notes.
 *
 * Deliberately a *second* small implementation rather than an import of the
 * journal's: the two plugins are loaded independently through the profile, may
 * be mounted in different orders, and one of them must keep working when the
 * other is absent. Sharing twenty lines of normalization costs less than a
 * hidden load-order dependency between two policies.
 *
 * The algorithm is the same one the journal uses, and it has to be: the gate's
 * notion of "the same failure twice" must agree with the journal the model reads
 * back, or the gate would speak up about a cluster the journal does not show.
 *
 * @module @dsh-external/dsh-policy-strict-gate/signature
 */

import { createHash } from 'node:crypto'

/** Collapse a message to the part that carries its cause. */
export function normalizeMessage(message) {
  return String(message ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' ⏎ ')
    .replace(/[A-Za-z]:\\[^\s'"<>|]+/g, '<path>')
    .replace(/\/(?:[\w.@-]+\/)+[\w.@-]+/g, '<path>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\b\d{5,}\b/g, '<n>')
    .trim()
    .slice(0, 240)
}

/** The first meaningful line of a message. */
export function headLine(message) {
  for (const line of String(message ?? '').split('\n')) {
    const text = line.trim()
    if (text !== '') return text
  }
  return ''
}

/**
 * Recover a failure class when the tool reported none.
 *
 * The harness reports no `error.info` for failures it raised itself — an unknown
 * tool, a denied call, a blocked post-execute — and those are exactly the
 * failures a reader most needs labelled.
 * @param message - the failure message.
 * @returns a stable uppercase code.
 */
export function classify(message) {
  const text = String(message ?? '')
  if (/EPERM|EACCES|permission denied|access is denied/i.test(text)) return 'PERMISSION_DENIED'
  if (/ENOENT|no such file or directory/i.test(text)) return 'ENOENT'
  if (/not recognized as (a name|an operable program)|command not found|is not recognized/i.test(text))
    return 'COMMAND_NOT_FOUND'
  if (/unknown tool|not registered|UNKNOWN_TOOL/i.test(text)) return 'UNKNOWN_TOOL'
  if (/timed out|timeout|ETIMEDOUT/i.test(text)) return 'TIMEOUT'
  if (/aborted|abort|cancell?ed|ABORTED/i.test(text)) return 'ABORTED'
  if (/strict-gate 拒绝/.test(text)) return 'GATE_REFUSAL'
  if (/String to replace|old_string|oldString/i.test(text)) return 'EDIT_NO_MATCH'
  if (/is not unique|appears \d+ times|multiple matches/i.test(text)) return 'EDIT_NOT_UNIQUE'
  if (/syntaxerror|unexpected token|parse error|cannot parse/i.test(text)) return 'SYNTAX'
  if (/schema|validation|invalid argument/i.test(text)) return 'BAD_ARGS'
  if (/assert|expect|failed test|test failed/i.test(text)) return 'TEST_FAILURE'
  return 'TOOL_FAILURE'
}

/**
 * Shipped remediation, keyed by failure class.
 *
 * Every entry answers one question: given this code, what is the next action
 * that is *different* from the one that just failed. Entries that would only
 * restate the error are omitted rather than padded.
 */
const REMEDIATION = Object.freeze({
  GATE_REFUSAL: [
    'The write was refused by policy, not by the filesystem. Read the refusal: it names the protected rule and the spec paths to satisfy.',
    'Do not retry the same write. Either satisfy the gate, or fix the diagnostics it reported when it allowed the repair.',
  ],
  EDIT_NO_MATCH: [
    'The replacement was matched literally against a file that changed since it was read.',
    'Re-read the exact region, then copy the old text from the fresh read rather than reconstructing it.',
  ],
  EDIT_NOT_UNIQUE: ['The old text occurs more than once. Widen the match with unique surrounding context.'],
  ENOENT: ['The path does not exist at that exact depth. List the parent directory and copy the real name.'],
  COMMAND_NOT_FOUND: ['The binary is not on PATH for the spawned shell. Resolve its absolute path once.'],
  PERMISSION_DENIED: ['The write was refused by the sandbox, not by the program. Check the target is inside the writable root.'],
  UNKNOWN_TOOL: ['That tool name is not registered in this profile. Use a registered equivalent.'],
  TIMEOUT: ['The call was killed on its deadline and may have had partial effects. Narrow the scope before re-running.'],
  ABORTED: ['Cancellation, not a defect. Do not treat it as a failing test.'],
  SYNTAX: ['The file no longer parses. Diff the changed region against the previous version before editing further.'],
  BAD_ARGS: ['The arguments did not satisfy the tool schema. Re-read the tool description for the exact parameter names.'],
  TEST_FAILURE: ['A test or assertion failed. Fix the cause the assertion names, not the assertion.'],
  TOOL_FAILURE: [],
})

/** Notes to attach to one failure code. */
export function remediationFor(code) {
  return REMEDIATION[code] ?? []
}

/**
 * The stable identity of a failure: same tool, same class, same cause.
 * @param tool - the tool that ran.
 * @param code - the failure class.
 * @param message - the failure message.
 * @returns a short stable signature.
 */
export function messageSignature(tool, code, message) {
  const material = [String(tool ?? ''), String(code ?? ''), normalizeMessage(message)].join('\u0000')
  return createHash('sha1').update(material).digest('hex').slice(0, 12)
}

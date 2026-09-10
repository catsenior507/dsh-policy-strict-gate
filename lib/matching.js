/**
 * Path matching and tool-argument reading.
 *
 * The critical-path gate decides everything from a glob match and a file path,
 * so both have to be honest about what they do and do not understand. Two
 * rules:
 *
 * - **An unmatched path is not a protected path.** A pattern this module cannot
 *   compile is dropped with a warning at mount rather than treated as
 *   "everything" — failing open on a typo is bad, but failing *closed* on a typo
 *   would block every write in the workspace and there would be no way to tell
 *   why.
 * - **A path this module cannot find is not a write.** The gate only fires when
 *   it can name the file a call will touch. Guessing would block calls that have
 *   nothing to do with the protected path.
 *
 * @module @dsh-external/dsh-policy-strict-gate/matching
 */

import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

/**
 * Expand a `{a,b}` alternation into the patterns it stands for.
 *
 * Brace alternation is widely used in real ignore lists (`*.{ts,tsx}`) and
 * silently failing to match it would leave a protected path unprotected with no
 * signal at all.
 * @param pattern - one glob, possibly containing brace groups.
 * @returns one or more brace-free globs.
 */
export function expandBraces(pattern) {
  const text = String(pattern ?? '')
  const open = text.indexOf('{')
  if (open < 0) return [text]
  let depth = 0
  let close = -1
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close < 0) return [text]
  const head = text.slice(0, open)
  const tail = text.slice(close + 1)
  const options = []
  let current = ''
  let level = 0
  for (const character of text.slice(open + 1, close)) {
    if (character === '{') level += 1
    if (character === '}') level -= 1
    if (character === ',' && level === 0) {
      options.push(current)
      current = ''
      continue
    }
    current += character
  }
  options.push(current)
  const expanded = []
  for (const option of options) {
    for (const suffix of expandBraces(tail)) expanded.push(head + option + suffix)
  }
  return expanded
}

/**
 * Compile one glob to an anchored regular expression over forward-slash paths.
 *
 * Supported: `**` (any number of path segments), `*` (within one segment), `?`,
 * and `[...]` character classes. `**` is the only construct with cross-segment
 * meaning, which is why it is handled before `*` rather than by the same rule.
 * @param pattern - the glob.
 * @returns an anchored RegExp.
 */
export function globToRegExp(pattern) {
  let source = ''
  const text = String(pattern ?? '')
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '*') {
      const isDouble = text[index + 1] === '*'
      if (isDouble) {
        // `**/` may match zero segments, so `src/**/x` must also match `src/x`.
        const followedBySlash = text[index + 2] === '/'
        source += followedBySlash ? '(?:[^/]+/)*' : '.*'
        index += followedBySlash ? 2 : 1
        continue
      }
      source += '[^/]*'
      continue
    }
    if (character === '?') {
      source += '[^/]'
      continue
    }
    if (character === '[') {
      const close = text.indexOf(']', index + 1)
      if (close > index) {
        const body = text.slice(index + 1, close)
        source += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body) + ']'
        index = close
        continue
      }
      source += '\\['
      continue
    }
    source += character.replace(/[.+^${}()|\\\]]/g, '\\$&')
  }
  return new RegExp('^' + source + '$')
}

/**
 * A compiled set of globs matched against a path.
 *
 * Every path is reduced to a workspace-relative, forward-slash form before
 * matching, so a pattern written as `src/core/**` matches whether the caller
 * passed `src/core/a.ts`, `./src/core/a.ts`, or the absolute
 * `D:\work\src\core\a.ts`. Matching an absolute path against a relative glob
 * would silently never fire, which is the kind of bug that makes a policy feel
 * present while doing nothing.
 */
export class PathMatcher {
  /**
   * @param patterns - glob strings.
   * @param root - the workspace root used to relativize paths.
   * @param onInvalid - called with each pattern that produced no usable glob.
   */
  constructor(patterns, root, onInvalid) {
    /** The workspace root, normalized. */
    this.root = normalize(String(root ?? process.cwd()))
    /** Compiled rules: `{ pattern, expression }`. */
    this.rules = []
    for (const pattern of patterns ?? []) {
      const text = String(pattern ?? '').trim()
      if (text === '') continue
      try {
        for (const expanded of expandBraces(text)) {
          this.rules.push({ pattern: text, expression: globToRegExp(expanded) })
        }
      } catch (error) {
        if (typeof onInvalid === 'function') onInvalid(text, error)
      }
    }
  }

  /** Whether the matcher has any rule at all. */
  get active() {
    return this.rules.length > 0
  }

  /**
   * The workspace-relative, forward-slash form of a path.
   * @param path - absolute or relative path.
   * @returns the relative form, or null when the path escapes the root.
   */
  relativize(path) {
    const text = String(path ?? '').trim()
    if (text === '') return null
    const absolute = isAbsolute(text) ? normalize(text) : resolve(this.root, text)
    const relation = relative(this.root, absolute)
    if (relation === '' || relation.startsWith('..')) return null
    return relation.split(sep).join('/')
  }

  /**
   * The absolute form of a path, resolved against the root.
   * @param path - absolute or relative path.
   * @returns the absolute path.
   */
  absolutize(path) {
    const text = String(path ?? '').trim()
    if (text === '') return text
    return isAbsolute(text) ? normalize(text) : resolve(this.root, text)
  }

  /**
   * Match one path against every rule.
   * @param path - absolute or relative path.
   * @returns `{ matched, relative, absolute, pattern }`.
   */
  match(path) {
    const absolute = this.absolutize(path)
    const relativePath = this.relativize(path)
    if (relativePath === null) return { matched: false, relative: null, absolute, pattern: null }
    for (const rule of this.rules) {
      if (rule.expression.test(relativePath)) return { matched: true, relative: relativePath, absolute, pattern: rule.pattern }
    }
    return { matched: false, relative: relativePath, absolute, pattern: null }
  }
}

/**
 * The argument keys that may hold the path a file tool will touch.
 *
 * Ordered by how specific the key is: `file_path`/`filePath` name the target
 * directly, while `path` is the harness `write`/`edit` spelling and `notebook_path`
 * comes from the notebook variant. Reading the first present key rather than a
 * fixed one keeps the gate working across the shipped file tools without
 * hard-coding a single tool's schema.
 */
export const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'absolute_path']

/** Argument keys that mean "this call replaces the file wholesale". */
export const CONTENT_KEYS = ['content', 'contents', 'text', 'new_string', 'newString']

/**
 * The path a file-touching call will write, if one can be named.
 * @param args - parsed tool arguments.
 * @returns the path string, or null when no path argument is present.
 */
export function extractPath(args) {
  if (args === null || typeof args !== 'object') return null
  for (const key of PATH_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Whether this call is creating a file rather than modifying one.
 * @param args - parsed tool arguments.
 * @returns true when the call carries file content.
 */
export function isCreating(args) {
  if (args === null || typeof args !== 'object') return false
  return CONTENT_KEYS.some((key) => typeof args[key] === 'string' && args[key] !== '')
}

/**
 * Whether a path names a Lean source, which the gate never blocks.
 *
 * A spec is how the gate is satisfied; refusing to let one be written would make
 * the gate unsatisfiable. Detecting it by extension rather than by the protected
 * globs means it holds even when the spec lives outside the protected tree.
 * @param path - the path to test.
 * @returns true when the path ends in `.lean`.
 */
export function isLeanSource(path) {
  return /\.lean$/i.test(String(path ?? '').trim())
}

/**
 * Candidate specification paths for one protected target.
 *
 * Three conventions, in the order a reader would guess them: a `.lean` sibling,
 * a `.spec.lean` sibling, and a same-named file under a `specs/` directory.
 * @param path - the protected target.
 * @returns candidate spec paths, absolute-or-as-given.
 */
export function specCandidates(path) {
  const text = String(path ?? '').trim()
  if (text === '') return []
  const withoutExtension = text.replace(/\.[^./\\]+$/, '')
  const directory = text.slice(0, Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1)
  return [withoutExtension + '.spec.lean', text + '.lean', directory + 'specs/' + baseName(withoutExtension) + '.lean']
}

/** The final path segment. */
function baseName(path) {
  const text = String(path ?? '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return cut < 0 ? text : text.slice(cut + 1)
}

/** Everything before the final path segment. */
function dirName(path) {
  const text = String(path ?? '')
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return cut < 0 ? '' : text.slice(0, cut + 1)
}

/**
 * The source files a specification covers.
 *
 * A spec names its subject by convention — `x.spec.lean` and `x.lean` both cover
 * the file `x` next to them — and the stem alone is **not** a usable target key,
 * because the real path carries an extension: the file is `x.ts`, not `x`.
 * Recording `x` opened the repair window on a path no write can ever match, so a
 * gate that reported an error then refused the fix to it, forever.
 *
 * The subject is therefore resolved against the directory: a sibling whose name
 * starts with the stem and is not itself Lean. When none exists the stem is
 * returned as a last resort, which still lets a clean verdict clear the key a
 * probe may have recorded.
 * @param specPath - the specification's path.
 * @returns candidate subject paths, longest name first so `x.ts` beats `x`.
 */
export function coveredTargets(specPath) {
  const stem = String(specPath ?? '').replace(/\.spec\.lean$/i, '').replace(/\.lean$/i, '')
  if (stem === '') return []
  const directory = dirName(stem)
  const base = baseName(stem)
  const subjects = []
  try {
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory)) {
        if (!entry.startsWith(base)) continue
        if (/\.lean$/i.test(entry)) continue
        subjects.push(directory + entry)
      }
    }
  } catch {
    // An unreadable directory is not a reason to lose the stem fallback.
  }
  subjects.sort((a, b) => b.length - a.length)
  return [...subjects, stem]
}

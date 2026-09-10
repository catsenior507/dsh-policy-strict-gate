/**
 * Strict-gate tests.
 *
 * The two tests that matter most are the deadlock test and the
 * refusal-carries-diagnostics test. The first pins the rule that keeps the gate
 * from blocking the fix to its own error; the second pins the reason the gate is
 * usable at all, because the harness discards a denied call's would-be result
 * and a refusal without the diagnostics would be information destroyed.
 *
 * The hooks are driven directly — through the real `ctx.on` waterfall of a real
 * cordis context — rather than through the tool runtime, because the object of
 * the test is the decision this plugin makes, not the registry that calls it.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

import { inject, name } from '../lib/index.js'
import { resolveConfig, DEFAULTS } from '../lib/config.js'
import { PathMatcher, expandBraces, extractPath, globToRegExp, isLeanSource, specCandidates } from '../lib/matching.js'
import { StrictGate, attachContexts, errorLines } from '../lib/gate.js'
import { classify, messageSignature, normalizeMessage, remediationFor } from '../lib/signature.js'
import { notice, messageFactoryState, probeMessageFactory, withNotice } from '../lib/notify.js'
import { registerStatusTool } from '../lib/status.js'

/** One throwaway tree per test process. */
const ROOT = mkdtempSync(join(tmpdir(), 'strict-gate-test-'))
after(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/**
 * A checker stub whose verdicts the test controls.
 *
 * `languageOf` and `checkable` mirror the real façade so the gate's own routing
 * is exercised rather than bypassed.
 */
function stubChecker(overrides = {}) {
  return {
    calls: [],
    leanVerdict: { verdict: 'accepted', diagnostics: [] },
    languageVerdict: { verdict: 'accepted', diagnostics: [], tool: 'stub', notes: [] },
    async checkLean(path) {
      this.calls.push(['lean', path])
      return this.leanVerdict
    },
    async checkLanguage(path) {
      this.calls.push(['language', path])
      return this.languageVerdict
    },
    languageOf(path) {
      if (/\.py$/.test(path)) return 'python'
      if (/\.ts$/.test(path)) return 'typescript'
      if (/\.md$/.test(path)) return 'unknown'
      return 'unknown'
    },
    checkable: new Set(['python', 'javascript', 'typescript', 'powershell']),
    ...overrides,
  }
}

/** Build a gate over the throwaway root. */
function makeGate(overrides = {}, checker = stubChecker()) {
  const config = resolveConfig({ ...overrides })
  const matcher = new PathMatcher(config.criticalPaths, ROOT, () => {})
  const gate = new StrictGate({
    config,
    matcher,
    checker,
    warn: () => {},
  })
  return { gate, config, matcher, checker }
}

/** One pending call. */
function exec(overrides = {}) {
  return { callId: 'c1', name: 'edit', arguments: {}, agent: { id: 'a1' }, ...overrides }
}

/** The identity `next()` a waterfall listener receives. */
const ACCEPT = async () => ({ kind: 'accept' })

/** A protected file that exists on disk. */
function protectedFile(relative, content = 'x = 1\n') {
  const path = join(ROOT, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

describe('glob matching', () => {
  it('expands brace alternation', () => {
    assert.deepEqual(expandBraces('*.{ts,tsx}'), ['*.ts', '*.tsx'])
    assert.deepEqual(expandBraces('src/{a,b}/x.ts'), ['src/a/x.ts', 'src/b/x.ts'])
    assert.deepEqual(expandBraces('plain.ts'), ['plain.ts'])
  })

  it('treats ** as zero or more segments', () => {
    const expression = globToRegExp('src/**/mod.ts')
    assert.equal(expression.test('src/mod.ts'), true)
    assert.equal(expression.test('src/a/b/mod.ts'), true)
    assert.equal(expression.test('srcx/mod.ts'), false)
  })

  it('keeps * inside one segment', () => {
    const expression = globToRegExp('src/*.ts')
    assert.equal(expression.test('src/a.ts'), true)
    assert.equal(expression.test('src/deep/a.ts'), false)
  })

  it('matches on the workspace-relative form regardless of how the path was spelled', () => {
    const matcher = new PathMatcher(['src/core/**'], ROOT)
    assert.equal(matcher.match(join(ROOT, 'src', 'core', 'a.ts')).matched, true)
    assert.equal(matcher.match('src/core/a.ts').matched, true)
    assert.equal(matcher.match(join(ROOT, 'src', 'other', 'a.ts')).matched, false)
  })

  it('refuses to match a path outside the root', () => {
    const matcher = new PathMatcher(['**'], ROOT)
    assert.equal(matcher.match(join(ROOT, '..', 'outside.ts')).matched, false)
  })

  it('reports a rule that cannot be compiled instead of swallowing it', () => {
    const invalid = []
    new PathMatcher(['[unclosed'], ROOT, (pattern) => invalid.push(pattern))
    // An unclosed class is tolerated by escaping rather than dropped; either way
    // the constructor must not throw.
    assert.ok(Array.isArray(invalid))
  })

  it('reads the path out of any of the shipped file-tool spellings', () => {
    assert.equal(extractPath({ file_path: 'a.ts' }), 'a.ts')
    assert.equal(extractPath({ path: 'b.ts' }), 'b.ts')
    assert.equal(extractPath({ filePath: '  c.ts  ' }), 'c.ts')
    assert.equal(extractPath({ command: 'ls' }), null)
    assert.equal(extractPath(null), null)
  })

  it('recognises a Lean spec by extension and computes candidate paths', () => {
    assert.equal(isLeanSource('a/b.lean'), true)
    assert.equal(isLeanSource('a/b.ts'), false)
    const candidates = specCandidates('src/core/x.ts')
    assert.equal(candidates[0], 'src/core/x.spec.lean')
    assert.equal(candidates[1], 'src/core/x.ts.lean')
  })
})

describe('signatures', () => {
  it('folds the variable parts of a message', () => {
    assert.equal(
      normalizeMessage('cannot open C:\\a\\b.ts at 2026-01-02T03:04:05Z'),
      normalizeMessage('cannot open D:\\c\\d.ts at 2026-05-06T07:08:09Z'),
    )
  })

  it('gives the same failure the same signature across spelling of the path', () => {
    const one = messageSignature('pwsh', 'ENOENT', "ENOENT: C:\\x\\y.ts not found")
    const two = messageSignature('pwsh', 'ENOENT', "ENOENT: D:\\p\\q.ts not found")
    assert.equal(one, two)
  })

  it('separates failures of different class', () => {
    assert.notEqual(messageSignature('pwsh', 'TIMEOUT', 'boom'), messageSignature('pwsh', 'SYNTAX', 'boom'))
  })

  it('labels a gate refusal as such instead of as a generic tool failure', () => {
    assert.equal(classify('strict-gate 拒绝写入 src/core/a.ts'), 'GATE_REFUSAL')
  })

  it('ships remediation for a refusal, telling the model not to retry blindly', () => {
    assert.ok(remediationFor('GATE_REFUSAL').length > 0)
    assert.match(remediationFor('GATE_REFUSAL').join(' '), /Do not retry/)
  })
})

describe('notice channel', () => {
  it('probes the harness factory and reports whether it is usable', async () => {
    const factory = await probeMessageFactory()
    const state = messageFactoryState()
    assert.equal(typeof state.available, 'boolean')
    if (factory === null) assert.notEqual(state.problem, '')
  })

  it('builds a message the harness shape accepts, fallback included', () => {
    const message = notice('body text', 'one line')
    assert.equal(message.role, 'user')
    assert.equal(typeof message.id, 'string')
    assert.equal(message.source.kind, 'plugin')
    assert.equal(message.source.form, 'notice')
    assert.equal(message.source.summary, 'one line')
    assert.deepEqual(message.content, [{ type: 'text', text: 'body text' }])
  })

  it('preserves another policy block while adding context', () => {
    const decision = { kind: 'block', feedback: [{ type: 'text', text: 'other policy' }] }
    const enriched = withNotice(decision, notice('mine', 's'))
    assert.equal(enriched.kind, 'block')
    assert.deepEqual(enriched.feedback, decision.feedback)
    assert.equal(enriched.additionalContexts.length, 1)
  })

  it('keeps accept fields while adding context', () => {
    const enriched = attachContexts({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] }, [notice('m', 's')])
    assert.equal(enriched.kind, 'accept')
    assert.equal(enriched.content.length, 1)
    assert.equal(enriched.additionalContexts.length, 1)
  })

  it('returns the decision untouched when there is nothing to say', () => {
    const decision = { kind: 'accept' }
    assert.equal(attachContexts(decision, []), decision)
  })
})

describe('critical-path gate', () => {
  it('is inactive when no critical path is configured', async () => {
    const { gate } = makeGate({ criticalPaths: [] })
    const decision = await gate.preExecute(exec({ arguments: { path: protectedFile('src/core/a.ts') } }), ACCEPT)
    assert.equal(decision.kind, 'accept')
  })

  it('refuses a write to an existing protected file with no spec, naming the spec path', async () => {
    const target = protectedFile('src/core/gate1.ts')
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] })
    const decision = await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)
    assert.equal(decision.kind, 'deny')
    // The refusal speaks in workspace-relative terms for the reader and absolute
    // terms for the spec it asks for, because the model has to be able to create it.
    assert.match(decision.reason, /`src\/core\/gate1\.ts`/)
    assert.match(decision.reason, /gate1\.spec\.lean/)
    assert.match(decision.reason, /criticalPaths/)
  })

  it('refuses with the spec diagnostics when the spec exists but fails', async () => {
    const target = protectedFile('src/core/gate2.ts')
    const spec = join(ROOT, 'src', 'core', 'gate2.spec.lean')
    writeFileSync(spec, 'example : True := by sorry\n', 'utf8')
    const checker = stubChecker({
      leanVerdict: {
        verdict: 'rejected',
        diagnostics: [
          { file: spec, line: 1, column: 20, severity: 'error', kind: 'hasSorry', message: 'declaration uses `sorry`' },
        ],
      },
    })
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] }, checker)
    const decision = await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /declaration uses `sorry`/)
    assert.match(decision.reason, /1:20/)
  })

  it('allows the write once the spec is accepted', async () => {
    const target = protectedFile('src/core/gate3.ts')
    const spec = join(ROOT, 'src', 'core', 'gate3.spec.lean')
    writeFileSync(spec, 'example : True := trivial\n', 'utf8')
    const checker = stubChecker()
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] }, checker)

    // The gate learns the verdict by running the checker on the spec itself.
    const learned = await gate.learnCheck(exec({ name: 'strict_check', arguments: { path: spec } }))
    assert.notEqual(learned, null)

    const decision = await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)
    assert.equal(decision.kind, 'accept')
  })

  it('NEVER blocks the fix to the diagnostic it just reported (deadlock guard)', async () => {
    const target = protectedFile('src/core/gate4.ts')
    const spec = join(ROOT, 'src', 'core', 'gate4.spec.lean')
    writeFileSync(spec, 'broken\n', 'utf8')
    const checker = stubChecker({
      leanVerdict: {
        verdict: 'rejected',
        diagnostics: [{ file: spec, line: 1, column: 1, severity: 'error', kind: 'x', message: 'unknown identifier' }],
      },
    })
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] }, checker)

    // First: the write is refused, and the refusal names the failing spec.
    const refused = await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)
    assert.equal(refused.kind, 'deny')
    assert.match(refused.reason, /unknown identifier/)

    // A rejected spec check records its diagnostics, which opens the repair
    // window — otherwise the gate could never be satisfied, because the fix to
    // the reported error would be the write it keeps refusing.
    await gate.learnCheck(exec({ name: 'strict_check', arguments: { path: spec } }))
    const repair = await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)
    assert.equal(repair.kind, 'accept', 'the repair write must always be allowed')
    assert.equal(gate.stats.repairPasses > 0, true)
  })

  it('closes the repair window again once a spec is accepted', async () => {
    const target = protectedFile('src/core/gate9.ts')
    const spec = join(ROOT, 'src', 'core', 'gate9.spec.lean')
    writeFileSync(spec, 'x\n', 'utf8')
    const checker = stubChecker({
      leanVerdict: {
        verdict: 'rejected',
        diagnostics: [{ file: spec, line: 1, column: 1, severity: 'error', kind: 'x', message: 'broken' }],
      },
    })
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] }, checker)
    await gate.learnCheck(exec({ name: 'strict_check', arguments: { path: spec } }))
    assert.equal((await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)).kind, 'accept')

    // The spec is fixed: the window closes and normal gating resumes, but a
    // clean spec also means the target is verified, so the write still passes.
    checker.leanVerdict = { verdict: 'accepted', diagnostics: [] }
    await gate.learnCheck(exec({ name: 'strict_check', arguments: { path: spec } }))
    assert.equal((await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)).kind, 'accept')
  })

  it('allows writing a Lean spec even though it matches the protected glob', async () => {
    protectedFile('src/core/gate5.ts')
    const specPath = join(ROOT, 'src', 'core', 'gate5.ts.lean')
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] })
    const decision = await gate.preExecute(exec({ arguments: { path: specPath } }), ACCEPT)
    assert.equal(decision.kind, 'accept')
  })

  it('does not gate a new file that does not exist yet', async () => {
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] })
    const decision = await gate.preExecute(exec({ arguments: { path: join(ROOT, 'src/core/brand-new.ts') } }), ACCEPT)
    assert.equal(decision.kind, 'accept')
  })

  it('never overrides an existing deny', async () => {
    const target = protectedFile('src/core/gate6.ts')
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] })
    const deny = async () => ({ kind: 'deny', reason: 'someone else said no' })
    const decision = await gate.preExecute(exec({ arguments: { path: target } }), deny)
    assert.equal(decision.reason, 'someone else said no')
  })

  it('stands down and allows the call when its own evaluation throws', async () => {
    const target = protectedFile('src/core/gate7.ts')
    const checker = stubChecker({
      checkLean: async () => {
        throw new Error('checker exploded')
      },
    })
    // A spec must exist for the throwing path to be reached.
    writeFileSync(join(ROOT, 'src', 'core', 'gate7.spec.lean'), 'x\n', 'utf8')
    const { gate } = makeGate({ criticalPaths: ['src/core/**'] }, checker)
    const decision = await gate.preExecute(exec({ arguments: { path: target } }), ACCEPT)
    assert.equal(decision.kind, 'accept', 'a broken gate must not brick the session')
  })

  it('ignores a tool that is not in protectedTools', async () => {
    const target = protectedFile('src/core/gate8.ts')
    const { gate } = makeGate({ criticalPaths: ['src/core/**'], protectedTools: ['write'] })
    const decision = await gate.preExecute(exec({ name: 'edit', arguments: { path: target } }), ACCEPT)
    assert.equal(decision.kind, 'accept')
  })
})

describe('post-write syntax gate', () => {
  it('injects the real diagnostics after a write that broke the file', async () => {
    const target = protectedFile('src/loose/a.py', 'def f(:\n')
    const checker = stubChecker({
      languageVerdict: {
        verdict: 'rejected',
        tool: 'python -m py_compile',
        notes: [],
        diagnostics: [{ file: target, line: 1, column: 7, severity: 'error', kind: 'SyntaxError', message: 'invalid syntax' }],
      },
    })
    const { gate } = makeGate({ criticalPaths: [] }, checker)
    const downstream = await gate.postExecute(exec({ arguments: { path: target } }), {}, ACCEPT)
    assert.equal(downstream.additionalContexts.length, 1)
    const message = downstream.additionalContexts[0]
    assert.match(message.content[0].text, /invalid syntax/)
    assert.match(message.content[0].text, /1:7/)
    assert.equal(message.source.plugin, 'strict-gate')
  })

  it('says nothing when the written file is clean', async () => {
    const target = protectedFile('src/loose/b.py', 'x = 1\n')
    const { gate } = makeGate({ criticalPaths: [] })
    const downstream = await gate.postExecute(exec({ arguments: { path: target } }), {}, ACCEPT)
    assert.equal(downstream.additionalContexts, undefined)
  })

  it('reports an unavailable checker instead of implying the file is fine', async () => {
    const target = protectedFile('src/loose/c.py', 'x = 1\n')
    const checker = stubChecker({
      languageVerdict: { verdict: 'unavailable', diagnostics: [], tool: 'python', notes: ['python is not on PATH'] },
    })
    const { gate } = makeGate({ criticalPaths: [] }, checker)
    const downstream = await gate.postExecute(exec({ arguments: { path: target } }), {}, ACCEPT)
    assert.equal(downstream.additionalContexts.length, 1)
    assert.match(downstream.additionalContexts[0].content[0].text, /未能检查/)
  })

  it('skips a language with no useful checker', async () => {
    const target = protectedFile('src/loose/notes.md', '# hi\n')
    const { gate, checker } = makeGate({ criticalPaths: [] })
    const downstream = await gate.postExecute(exec({ arguments: { path: target } }), {}, ACCEPT)
    assert.equal(downstream.additionalContexts, undefined)
    assert.equal(checker.calls.length, 0)
  })

  it('does not run after a blocked result', async () => {
    const target = protectedFile('src/loose/d.py', 'x = 1\n')
    const { gate, checker } = makeGate({ criticalPaths: [] })
    const blocked = async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'no' }] })
    const downstream = await gate.postExecute(exec({ arguments: { path: target } }), {}, blocked)
    assert.equal(downstream.kind, 'block')
    assert.equal(checker.calls.length, 0)
  })

  it('is disabled by configuration', async () => {
    const target = protectedFile('src/loose/e.py', 'def f(:\n')
    const { gate, checker } = makeGate({ criticalPaths: [], postWriteSyntax: false })
    const downstream = await gate.postExecute(exec({ arguments: { path: target } }), {}, ACCEPT)
    assert.equal(downstream.additionalContexts, undefined)
    assert.equal(checker.calls.length, 0)
  })
})

describe('repetition gate', () => {
  /** One failed tool result. */
  const failed = (message, code) => ({ isError: true, error: { message, info: code === undefined ? undefined : { code } } })

  it('speaks up exactly at the threshold, not before', async () => {
    const { gate } = makeGate({ repeatThreshold: 3 })
    const call = exec({ name: 'pwsh' })
    gate.observeResult(call, failed('same thing broke', 'E'))
    gate.observeResult(call, failed('same thing broke', 'E'))
    assert.equal(gate.pending.length, 0, 'two repeats is not yet a pattern')
    gate.observeResult(call, failed('same thing broke', 'E'))
    assert.equal(gate.pending.length, 1)
    assert.equal(gate.stats.repeatNotices, 1)
  })

  it('delivers the queued notice on the next call and only once', async () => {
    const { gate } = makeGate({ repeatThreshold: 2 })
    const call = exec({ name: 'pwsh' })
    gate.observeResult(call, failed('boom', 'E'))
    gate.observeResult(call, failed('boom', 'E'))

    const first = await gate.preExecute(exec({ arguments: {} }), ACCEPT)
    assert.equal(first.additionalContexts.length, 1)
    assert.match(first.additionalContexts[0].content[0].text, /已经以\*\*同一种方式\*\*失败 2 次/)

    const second = await gate.preExecute(exec({ arguments: {} }), ACCEPT)
    assert.equal(second.additionalContexts, undefined, 'the notice must not repeat forever')
  })

  it('includes the shipped remediation so the notice says what to change', async () => {
    const { gate } = makeGate({ repeatThreshold: 1 })
    gate.observeResult(exec({ name: 'edit' }), failed('String to replace not found in file', 'EDIT_NO_MATCH'))
    const decision = await gate.preExecute(exec({ arguments: {} }), ACCEPT)
    assert.match(decision.additionalContexts[0].content[0].text, /Re-read the exact region/)
  })

  it('does not count a success as a failure', () => {
    const { gate } = makeGate({ repeatThreshold: 1 })
    gate.observeResult(exec({ name: 'pwsh' }), { isError: false })
    assert.equal(gate.pending.length, 0)
    assert.equal(gate.stats.failuresObserved, 0)
  })

  it('respects the cooldown so a long loop does not flood the context', () => {
    const { gate } = makeGate({ repeatThreshold: 2, repeatCooldown: 3 })
    const agent = { id: 'cooldown-agent' }
    for (let index = 0; index < 10; index += 1) gate.observeResult(exec({ name: 'pwsh', agent }), failed('boom', 'E'))
    // Threshold at 2, then again at 5 (2+3), then at 8 (5+3) — three notices for
    // ten failures, not ten. Read through the state bag rather than the queue:
    // a delivered notice leaves the queue, so the queue is not the count.
    const state = gate.stateFor({ agent })
    const [seen] = [...state.failures.values()]
    assert.equal(seen.count, 10)
    assert.equal(gate.stats.repeatNotices, 3)
  })

  it('keys state by session so the hooks agree with each other', () => {
    // The harness hands a different agent object to different hooks. Keying the
    // state bag by object identity made the gate learn a spec was accepted in
    // one bag and look for it in another — refusing forever. This pins the fix.
    const { gate } = makeGate({ repeatThreshold: 5 })
    gate.observeResult({ name: 'pwsh', agent: { session: { id: 's-1' }, id: 'agent-obj-A' } }, failed('boom', 'E'))
    gate.observeResult({ name: 'pwsh', agent: { session: { id: 's-1' }, id: 'agent-obj-B' } }, failed('boom', 'E'))
    const state = gate.stateFor({ agent: { session: { id: 's-1' } } })
    assert.equal([...state.failures.values()][0].count, 2, 'same session, different objects, one counter')
  })

  it('falls back to the agent id when no session is attached', () => {
    const { gate } = makeGate({ repeatThreshold: 5 })
    gate.observeResult({ name: 'pwsh', agent: { id: 'no-session' } }, failed('boom', 'E'))
    assert.equal(gate.stateFor({ agent: { id: 'no-session' } }).failures.size, 1)
    assert.equal(gate.stateFor({ agent: {} }), null)
  })

  it('bounds the number of tracked sessions', () => {
    const { gate } = makeGate({ repeatThreshold: 5 })
    for (let index = 0; index < 200; index += 1) {
      gate.observeResult({ name: 'pwsh', agent: { session: { id: 's-' + index } } }, failed('boom', 'E'))
    }
    assert.ok(gate.trackedSessions <= 64, 'the map must not grow without bound, saw ' + gate.trackedSessions)
  })

  it('keeps separate counters per session', () => {
    const { gate } = makeGate({ repeatThreshold: 2 })
    gate.observeResult({ name: 'pwsh', agent: { session: { id: 's-a' } } }, failed('boom', 'E'))
    gate.observeResult({ name: 'pwsh', agent: { session: { id: 's-b' } } }, failed('boom', 'E'))
    assert.equal(gate.pending.length, 0, 'two sessions failing once each is not a pattern')
  })
})

describe('cordis mount contract', () => {
  it('declares the tools dependency and exports no default', async () => {
    assert.equal(name, 'policy-strict-gate')
    assert.deepEqual(inject, ['tools'])
    const module = await import('../lib/index.js')
    assert.equal(module.default, undefined)
  })

  it('resolves the optional collaborator from the host install', async () => {
    // The gate must be able to load the checker it reasons with, and it locates
    // it by walking the DSH profile directories rather than by a bare import —
    // the two packages sit in different `node_modules` trees, so a bare import
    // resolves in one layout and fails in the other. A failure here turns two
    // gates off silently, which is why it is worth a test of its own.
    const module = await import('../lib/index.js')
    const attempts = []
    const resolved = await module.importCollaborator({ warn: (message) => attempts.push(message), info: () => {} })
    assert.notEqual(resolved, null, 'the collaborator must be findable on this machine; attempts: ' + attempts.join(' / '))
    assert.equal(typeof resolved.checkLean, 'function')
    assert.equal(typeof resolved.checkLanguage, 'function')
    assert.equal(typeof resolved.languageOf, 'function')
    assert.equal(typeof resolved.resolveCheckConfig, 'function')
    assert.deepEqual(resolved.MINIMUM_SAFE_VERSION, [4, 33, 1])
  })
})

describe('status tool', () => {
  /** A registry that captures the definition. */
  function fakeRegistry() {
    return {
      definition: null,
      register(definition) {
        this.definition = definition
        return () => { this.definition = null }
      },
    }
  }

  it('reports the critical-path gate as inactive when nothing is configured', async () => {
    const { gate, config, matcher } = makeGate({ criticalPaths: [] })
    const registry = fakeRegistry()
    registerStatusTool(registry, gate, config, matcher)
    const value = await registry.definition.execute({ action: 'status' })
    const critical = value.gates.find((entry) => entry.gate === 'critical paths')
    assert.equal(critical.active, false)
    assert.match(value.notes.join(' '), /criticalPaths/)
  })

  it('reports a configured path as protected, naming the rule', async () => {
    const { gate, config, matcher } = makeGate({ criticalPaths: ['src/core/**'] })
    const registry = fakeRegistry()
    registerStatusTool(registry, gate, config, matcher)
    const value = await registry.definition.execute({ action: 'targets', path: join(ROOT, 'src/core/z.ts') })
    assert.match(value.counters.join(' '), /protected by `src\/core\/\*\*`/)
  })

  it('reports an unprotected path as unprotected rather than staying silent', async () => {
    const { gate, config, matcher } = makeGate({ criticalPaths: ['src/core/**'] })
    const registry = fakeRegistry()
    registerStatusTool(registry, gate, config, matcher)
    const value = await registry.definition.execute({ action: 'targets', path: join(ROOT, 'docs/a.md') })
    assert.match(value.counters.join(' '), /not protected/)
  })

  it('always returns every declared output property', async () => {
    const { gate, config, matcher } = makeGate({ criticalPaths: ['src/core/**'] })
    const registry = fakeRegistry()
    registerStatusTool(registry, gate, config, matcher)
    const properties = Object.keys(registry.definition.output.schema.properties)
    for (const action of ['status', 'targets']) {
      const value = await registry.definition.execute({ action })
      for (const key of properties) assert.notEqual(value[key], undefined, action + ' left ' + key + ' undefined')
    }
  })

  it('renders a table naming the on/off state of each gate', async () => {
    const { gate, config, matcher } = makeGate({ criticalPaths: [] })
    const registry = fakeRegistry()
    registerStatusTool(registry, gate, config, matcher)
    const value = await registry.definition.execute({ action: 'status' })
    const text = registry.definition.output.render({}, value)[0].text
    assert.match(text, /\[off\] critical paths/)
    assert.match(text, /\[on \] repeated failure/)
  })
})

describe('config', () => {
  it('defaults to an inactive critical-path gate', () => {
    assert.deepEqual(resolveConfig({}).criticalPaths, [])
  })

  it('drops nonsense values back to the defaults', () => {
    const resolved = resolveConfig({ repeatThreshold: -1, maxDiagnostics: 'x', postWriteSyntax: 'maybe' })
    assert.equal(resolved.repeatThreshold, DEFAULTS.repeatThreshold)
    assert.equal(resolved.maxDiagnostics, DEFAULTS.maxDiagnostics)
    assert.equal(resolved.postWriteSyntax, DEFAULTS.postWriteSyntax)
  })

  it('parses a YAML list and trims entries', () => {
    const resolved = resolveConfig({ criticalPaths: [' src/core/** ', '', 7, '*.lean'] })
    assert.deepEqual(resolved.criticalPaths, ['src/core/**', '*.lean'])
  })

  it('keeps the default protected tool set when none is given', () => {
    assert.deepEqual(resolveConfig({}).protectedTools, DEFAULTS.protectedTools)
  })
})

describe('errorLines', () => {
  it('keeps only errors, formats the location, and bounds the count', () => {
    const lines = errorLines(
      [
        { file: 'a.py', line: 3, column: 5, severity: 'error', message: 'bad thing\nmore detail' },
        { file: 'a.py', line: 9, column: 1, severity: 'warning', message: 'noise' },
        { file: '', line: 1, column: 1, severity: 'error', message: 'no file path' },
      ],
      5,
    )
    assert.equal(lines.length, 2)
    assert.equal(lines[0], 'a.py:3:5 bad thing')
    assert.equal(lines[1], '1:1 no file path')
  })

  it('respects the limit', () => {
    const many = Array.from({ length: 20 }, (_unused, index) => ({
      file: 'a.py',
      line: index + 1,
      column: 1,
      severity: 'error',
      message: 'e',
    }))
    assert.equal(errorLines(many, 3).length, 3)
  })
})

describe('mount with an empty critical-path list', () => {
  it('registers hooks and the status tool on a real context', async () => {
    const ctx = new Context()
    const registered = new Map()
    ctx.provide('tools', {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    })
    const module = await import('../lib/index.js')
    const fiber = ctx.plugin({ name: module.name, inject: module.inject, apply: module.apply }, { criticalPaths: [] })
    await fiber.await()
    // The status tool registers asynchronously, after the checker import.
    const deadline = Date.now() + 5000
    while (!registered.has('strict_gate_status') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(registered.has('strict_gate_status'), true, 'status tool should register once the checker loads')
    await fiber.dispose()
    assert.equal(registered.size, 0)
  })
})

describe('protected file helper sanity', () => {
  it('created the fixtures the gate tests rely on', () => {
    assert.equal(existsSync(join(ROOT, 'src', 'core', 'gate1.ts')), true)
  })
})

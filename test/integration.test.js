/**
 * Integration with the real checkers.
 *
 * The unit tests drive a stub, which proves the gate's logic but not that the
 * gate and `strict_check` agree on what "verified" means. These tests use the
 * actual Lean toolchain through the actual collaborator, because the failure they
 * guard against is silent: two plugins that disagree about a verdict would leave
 * the gate refusing writes that the model was told were fine.
 *
 * Skipped — not faked — when no safe toolchain is present. On such a machine the
 * gate reports `unavailable` and stands down, which the unit tests already cover.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PathMatcher } from '../lib/matching.js'
import { resolveConfig } from '../lib/config.js'
import { StrictGate } from '../lib/gate.js'
import { importCollaborator } from '../lib/index.js'

/** One throwaway tree per test process. */
const ROOT = mkdtempSync(join(tmpdir(), 'strict-gate-integration-'))
after(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** The real checker façade, built the same way the host builds it. */
async function realChecker(timeoutMs = 90_000) {
  const strictCheck = await importCollaborator({ warn: () => {}, info: () => {} })
  if (strictCheck === null) return null
  const base = strictCheck.resolveCheckConfig({})
  const options = { ...base, timeoutMs, maxOutputChars: 20_000 }
  return {
    strictCheck,
    facade: {
      checkLean: (path, extra) => strictCheck.checkLean(options, { path, ...(extra ?? {}) }),
      checkLanguage: (path, languageName) => strictCheck.checkLanguage(options, path, languageName),
      languageOf: strictCheck.languageOf,
      checkable: new Set(['python', 'javascript', 'typescript', 'powershell']),
    },
  }
}

/** Build a gate over the throwaway root with the real checker. */
async function realGate(checker, criticalPaths = ['protected/**']) {
  const config = resolveConfig({ criticalPaths })
  return new StrictGate({
    config,
    matcher: new PathMatcher(config.criticalPaths, ROOT, () => {}),
    checker,
    warn: () => {},
  })
}

/** Create a file under the throwaway root. */
function fixture(relative, content) {
  const path = join(ROOT, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

describe('against the real Lean toolchain', () => {
  let usable = false
  let checker = null

  before(async () => {
    const loaded = await realChecker()
    if (loaded === null) return
    checker = loaded.facade
    // The gate's public surface is deliberately narrow — it exports the two
    // checks and the config resolver, not the detection helper — so the
    // toolchain probe is taken from the checker package the gate has already
    // located, rather than by importing it again from this file.
    const detection = await loaded.facade.checkLean(join(ROOT, '__toolchain-probe__.lean'))
    usable = detection.verdict !== 'unavailable' && detection.toolchainSafe === true
  })

  it('accepts a write whose spec the real kernel accepted', async (t) => {
    if (!usable) return t.skip('no safe Lean toolchain on this machine')
    const target = fixture('protected/covered.ts', 'export const x = 1\n')
    const spec = fixture('protected/covered.spec.lean', 'example : (2 + 2 : Nat) = 4 := by decide\n')

    const gate = await realGate(checker)
    const learned = await gate.learnCheck({ name: 'strict_check', arguments: { path: spec }, agent: { session: { id: 'real-1' } } })
    assert.notEqual(learned, null)

    const decision = await gate.preExecute(
      { callId: 'c', name: 'edit', arguments: { path: target }, agent: { session: { id: 'real-1' } } },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(decision.kind, 'accept')
  }, 120_000)

  it('refuses while the real kernel rejects the spec, then allows the repair', async (t) => {
    if (!usable) return t.skip('no safe Lean toolchain on this machine')
    const target = fixture('protected/broken.ts', 'export const y = 2\n')
    // A `sorry` is a warning in Lean and exits 0; only the promoted flag makes it
    // a rejection. If the gate and strict_check ever disagreed on the flags, this
    // is the assertion that would fail.
    const spec = fixture('protected/broken.spec.lean', 'example : (2 + 2 : Nat) = 5 := by sorry\n')
    const agent = { session: { id: 'real-2' } }
    const gate = await realGate(checker)

    const first = await gate.preExecute(
      { callId: 'c1', name: 'edit', arguments: { path: target }, agent },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(first.kind, 'deny')
    assert.match(first.reason, /declaration uses `sorry`|sorry/)

    await gate.learnCheck({ name: 'strict_check', arguments: { path: spec }, agent })
    const repair = await gate.preExecute(
      { callId: 'c2', name: 'edit', arguments: { path: target }, agent },
      async () => ({ kind: 'accept' }),
    )
    assert.equal(repair.kind, 'accept', 'the fix to a reported error must never be blocked')
  }, 120_000)

  it('runs the real Python compiler after a write and injects the diagnostic', async (t) => {
    if (checker === null) return t.skip('no collaborator available')
    const target = fixture('unprotected/broken.py', 'def f(:\n')
    const gate = await realGate(checker, [])
    const downstream = await gate.postExecute(
      { callId: 'c', name: 'edit', arguments: { path: target }, agent: { session: { id: 'real-3' } } },
      {},
      async () => ({ kind: 'accept' }),
    )
    assert.equal(downstream.additionalContexts.length, 1, 'a broken write must produce a notice')
    assert.match(downstream.additionalContexts[0].content[0].text, /SyntaxError|invalid syntax|error/i)
  }, 120_000)

  it('stays quiet after a clean write of a real file', async (t) => {
    if (checker === null) return t.skip('no collaborator available')
    const target = fixture('unprotected/fine.py', 'def f(n):\n    return n + 1\n')
    const gate = await realGate(checker, [])
    const downstream = await gate.postExecute(
      { callId: 'c', name: 'edit', arguments: { path: target }, agent: { session: { id: 'real-4' } } },
      {},
      async () => ({ kind: 'accept' }),
    )
    assert.equal(downstream.additionalContexts, undefined)
  }, 120_000)
})

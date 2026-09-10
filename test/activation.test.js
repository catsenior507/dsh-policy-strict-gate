/**
 * End-to-end activation through the real cordis event bus.
 *
 * Every other test calls the gate's methods directly, which proves the decisions
 * but not the wiring. This file drives the actual `tools/pre-execute`,
 * `tools/post-execute` and `tools/result` waterfalls on a real `Context`, with
 * `strict-check` mounted beside the gate exactly as the profile mounts them.
 *
 * That distinction matters because the failure modes are invisible to a direct
 * call: a listener registered on the wrong event name, a waterfall that never
 * calls `next()`, an event name that the harness emits with a different argument
 * shape, or a gate whose `inject` declaration prevents it from ever applying.
 * None of those throw — they just make the policy silently absent.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'

import * as gateModule from '../lib/index.js'

/** One throwaway tree per test process. */
const ROOT = mkdtempSync(join(tmpdir(), 'strict-gate-e2e-'))
after(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Create a file under the throwaway root. */
function fixture(relative, content) {
  const path = join(ROOT, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
  return path
}

/**
 * Mount the gate on a fresh context with a `tools` registry.
 *
 * `process.chdir` is needed because the matcher relativizes paths against the
 * working directory, exactly as it does in the host.
 *
 * The hooks attach only after the optional collaborator finishes importing, so
 * the helper waits for that rather than letting each test race it. A test that
 * emits an event before the listener exists passes for the wrong reason — it
 * would report "the gate allowed it" when the gate was not there at all.
 * @param config - the plugin row config.
 * @returns the context, the registry map, and a ready promise.
 */
async function mountGate(config) {
  const ctx = new Context()
  const registered = new Map()
  ctx.provide('tools', {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  })
  const previous = process.cwd()
  process.chdir(ROOT)
  const fiber = ctx.plugin({ name: gateModule.name, inject: gateModule.inject, apply: gateModule.apply }, config)
  await fiber.await()
  // `strict_gate_status` is registered in the same continuation that attaches the
  // hooks, so its presence is the signal that the gate is live.
  const ready = await until(() => registered.has('strict_gate_status') || ctx.fiber?.state === 4)
  return {
    ctx,
    registered,
    ready,
    async dispose() {
      await fiber.dispose()
      process.chdir(previous)
    },
  }
}

/** Wait until a predicate holds, or give up. */
async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  return predicate()
}

/** One pending call as the harness emits it. */
function execution(name, args, sessionId = 'e2e-session') {
  return { callId: 'call-1', name, arguments: args, agent: { id: sessionId, session: { id: sessionId } }, signal: undefined }
}

/** One failed settled result. */
function failure(message, code) {
  return { isError: true, error: { message, info: code === undefined ? undefined : { code } }, content: [] }
}

describe('activation through the real event bus', () => {
  it('applies and registers its status tool when criticalPaths is empty', async () => {
    const mounted = await mountGate({ criticalPaths: [] })
    try {
      assert.equal(
        await until(() => mounted.registered.has('strict_gate_status')),
        true,
        'the status tool must register once the optional collaborator loads',
      )
    } finally {
      await mounted.dispose()
    }
  })

  it('delivers a repeat notice on the next call through the pre-execute waterfall', async () => {
    const mounted = await mountGate({ criticalPaths: [], repeatThreshold: 2, postWriteSyntax: false })
    try {
      assert.equal(mounted.ready, true, 'the gate must attach its hooks before any event is emitted')
      const exec = execution('pwsh', { command: 'nope' })

      // Two abnormal outcomes reach the gate on `tools/result`, which has no
      // decision channel, so the notice must be queued rather than delivered.
      mounted.ctx.emit('tools/result', exec, failure('the same thing broke', 'E_SAME'))
      mounted.ctx.emit('tools/result', exec, failure('the same thing broke', 'E_SAME'))

      // The next call — whatever it is — carries it to the model. This is the
      // delivery contract: a failure cannot attach context to itself, so the
      // notice is always one step late and never lost.
      const decision = await mounted.ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
      assert.equal(decision.kind, 'allow', 'enriching must never replace the decision')
      assert.equal(Array.isArray(decision.additionalContexts), true, 'the notice must ride the decision')
      assert.equal(decision.additionalContexts.length, 1)
      const text = decision.additionalContexts[0].content[0].text
      assert.match(text, /同一种方式/)
      assert.equal(decision.additionalContexts[0].source.plugin, 'strict-gate')
      assert.equal(decision.additionalContexts[0].source.form, 'notice')
      assert.equal(typeof decision.additionalContexts[0].source.summary, 'string')

      // Once only: the queue is drained, so the next call is quiet again.
      const quiet = await mounted.ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }))
      assert.equal(quiet.additionalContexts, undefined)
    } finally {
      await mounted.dispose()
    }
  })

  it('rides its own post-execute result when the notice is produced there', async () => {
    const target = fixture('checked/rides.py', 'def f(:\n')
    const mounted = await mountGate({ criticalPaths: [], postWriteSyntax: true })
    try {
      assert.equal(mounted.ready, true, 'the gate must attach its hooks before any event is emitted')
      const decision = await mounted.ctx.waterfall(
        'tools/post-execute',
        execution('edit', { path: target }),
        { isError: false },
        async () => ({ kind: 'accept' }),
      )
      // A notice produced inside post-execute has an accepted call to ride, so it
      // reaches the model one step earlier than a queued one. Both paths must
      // work, which is why they are separate tests.
      assert.equal(Array.isArray(decision.additionalContexts), true)
      assert.equal(decision.additionalContexts.length, 1)
      assert.match(decision.additionalContexts[0].content[0].text, /错误|error/i)
    } finally {
      await mounted.dispose()
    }
  })

  it('refuses a write to a protected path through the pre-execute waterfall', async () => {
    const target = fixture('protected/e2e.ts', 'export const x = 1\n')
    const mounted = await mountGate({ criticalPaths: ['protected/**'], postWriteSyntax: false })
    try {
      assert.equal(mounted.ready, true, 'the gate must attach its hooks before any event is emitted')
      const decision = await mounted.ctx.waterfall(
        'tools/pre-execute',
        execution('edit', { path: target }),
        async () => ({ kind: 'allow' }),
      )
      assert.equal(decision.kind, 'deny')
      assert.match(decision.reason, /protected\/e2e\.ts/)
      assert.match(decision.reason, /e2e\.spec\.lean/)
    } finally {
      await mounted.dispose()
    }
  })

  it('passes a write through when no critical path is configured', async () => {
    const target = fixture('unprotected/e2e.ts', 'export const x = 1\n')
    const mounted = await mountGate({ criticalPaths: [], postWriteSyntax: false })
    try {
      assert.equal(mounted.ready, true, 'the gate must attach its hooks before any event is emitted')
      const decision = await mounted.ctx.waterfall(
        'tools/pre-execute',
        execution('edit', { path: target }),
        async () => ({ kind: 'allow' }),
      )
      assert.equal(decision.kind, 'allow')
    } finally {
      await mounted.dispose()
    }
  })

  it('runs the real post-write check inside the waterfall and injects the diagnostic', async () => {
    const target = fixture('checked/broken.py', 'def f(:\n')
    const mounted = await mountGate({ criticalPaths: [], postWriteSyntax: true })
    try {
      assert.equal(mounted.ready, true, 'the gate must attach its hooks before any event is emitted')
      const decision = await mounted.ctx.waterfall(
        'tools/post-execute',
        execution('edit', { path: target }),
        { isError: false },
        async () => ({ kind: 'accept' }),
      )
      assert.equal(Array.isArray(decision.additionalContexts), true, 'a broken write must produce a notice')
      assert.match(decision.additionalContexts[0].content[0].text, /错误|error/i)
    } finally {
      await mounted.dispose()
    }
  })

  it('never cancels another listener that blocked the call', async () => {
    const target = fixture('checked/blocked.py', 'x = 1\n')
    const mounted = await mountGate({ criticalPaths: [] })
    try {
      assert.equal(mounted.ready, true, 'the gate must attach its hooks before any event is emitted')
      const feedback = [{ type: 'text', text: 'another policy said no' }]
      const decision = await mounted.ctx.waterfall(
        'tools/post-execute',
        execution('edit', { path: target }),
        { isError: false },
        async () => ({ kind: 'block', feedback }),
      )
      assert.equal(decision.kind, 'block')
      assert.deepEqual(decision.feedback, feedback, "another policy's block must survive intact")
    } finally {
      await mounted.dispose()
    }
  })

  it('survives disposal while the collaborator is still loading', async () => {
    // The hooks attach from an async continuation, so a reload or shutdown can
    // dispose the fiber before the import resolves. Registering an effect then
    // throws `cannot create effect on inactive context`, and because the
    // continuation is a floating promise that throw became an *unhandled
    // rejection in the host* — a host-level fault caused by a plugin being
    // unloaded. This test disposes immediately and lets the continuation land.
    const rejections = []
    const onRejection = (reason) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const ctx = new Context()
      ctx.provide('tools', { register: () => () => {} })
      const previous = process.cwd()
      process.chdir(ROOT)
      const fiber = ctx.plugin({ name: gateModule.name, inject: gateModule.inject, apply: gateModule.apply }, { criticalPaths: [] })
      // No `await fiber.await()` and no readiness wait: dispose into the race.
      await fiber.dispose()
      // Give the collaborator import every chance to resolve afterwards.
      await new Promise((resolve) => setTimeout(resolve, 400))
      process.chdir(previous)
      assert.deepEqual(rejections, [], 'a disposed context must not produce an unhandled rejection')
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('releases every listener on dispose', async () => {
    const mounted = await mountGate({ criticalPaths: [], postWriteSyntax: false })
    const target = fixture('disposed/x.ts', 'x\n')
    await until(() => mounted.registered.has('strict_gate_status'))
    await mounted.dispose()
    assert.equal(mounted.registered.size, 0, 'disposal must unregister the tool')

    // A disposed listener must be gone: the context is still usable, and a
    // surviving hook would keep policing a plugin that is meant to be off.
    const decision = await mounted.ctx.waterfall(
      'tools/pre-execute',
      execution('edit', { path: target }),
      async () => ({ kind: 'allow' }),
    )
    assert.equal(decision.kind, 'allow')
    assert.equal(decision.reason, undefined)
  })
})

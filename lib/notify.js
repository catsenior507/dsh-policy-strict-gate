/**
 * The one channel that can put a sentence in front of the model's next step.
 *
 * A `tools/post-execute` listener may attach `additionalContexts`, which the
 * agent loop commits as a user-role message for the following step. The harness
 * itself uses this for its own repeat reminder, so it is the supported way to
 * make a policy audible rather than merely enforced.
 *
 * Constructing that message is the fiddly part. `createUserMessage` allocates
 * the stable identity the harness expects, and it lives in `@deepseek-ai/dsh-llm`
 * — a module this plugin cannot declare as a dependency, because a linked plugin
 * has no `node_modules` of its own and the harness module table is not an import
 * surface. So the import is attempted dynamically and **verified**, and if it
 * ever fails the message is built by hand against a locally generated id. A
 * policy that blocks work but cannot say why is worse than one that does not
 * block, so a broken notice channel is a reported event, not a silent degrade.
 *
 * @module @dsh-external/dsh-policy-strict-gate/notify
 */

import { randomUUID } from 'node:crypto'

/** The plugin name recorded on every injected message. */
export const PLUGIN_NAME = 'strict-gate'

/** Cache of the verified message factory: `null` means "probe not run or failed". */
let factory = null
/** Why the fallback is in use, surfaced through the status tool. */
let factoryProblem = 'not probed yet'

/**
 * Probe the harness message factory once.
 *
 * The probe does not merely import: it calls the factory with the exact input
 * shape this module uses and checks that an identity came back. An import that
 * resolves but returns something else would fail later, inside an event
 * listener, where the registry contains the throw and the notice simply never
 * arrives.
 * @returns the factory, or null when the fallback must be used.
 */
export async function probeMessageFactory() {
  if (factory !== null) return factory
  try {
    const module = await import('@deepseek-ai/dsh-llm')
    if (typeof module.createUserMessage !== 'function') {
      factoryProblem = 'dsh-llm loaded but exports no createUserMessage'
      return null
    }
    const probe = module.createUserMessage({
      content: [{ type: 'text', text: 'probe' }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: 'probe' },
    })
    if (probe === null || typeof probe !== 'object' || typeof probe.id !== 'string') {
      factoryProblem = 'createUserMessage returned no message identity'
      return null
    }
    factory = module.createUserMessage
    factoryProblem = ''
    return factory
  } catch (error) {
    factoryProblem = 'could not import @deepseek-ai/dsh-llm: ' + String(error?.message ?? error)
    return null
  }
}

/** Whether the harness factory is available; for the status tool. */
export function messageFactoryState() {
  return { available: factory !== null, problem: factoryProblem }
}

/**
 * Build one plugin-sourced notice for the next model step.
 *
 * `form: 'notice'` is the shape the harness renders as a collapsed transcript
 * row, and `summary` is the one line shown without expanding it — so the summary
 * is written to be worth reading on its own, not as a label for the body.
 * @param text - the full message the model reads.
 * @param summary - the one-line account; bounded by the harness.
 * @returns a user-role message.
 */
export function notice(text, summary) {
  const source = { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: String(summary ?? '').slice(0, 120) }
  const content = [{ type: 'text', text: String(text ?? '') }]
  if (factory !== null) return factory({ content, source })
  // Fallback: the same shape, with an identity this process owns. It is frozen
  // for the same reason the harness freezes its own — a message that a later
  // listener could mutate would make the durable log disagree with the wire.
  return Object.freeze({ id: 'strict-gate-' + randomUUID(), role: 'user', content, source })
}

/**
 * Attach a notice to whatever a downstream `post-execute` decision already
 * decided, without ever discarding that decision.
 *
 * This shape is taken from the harness's own repeat reminder: `block` must be
 * preserved exactly (its `feedback` is another listener's work), and every other
 * decision keeps its fields while gaining the context. Replacing the decision
 * instead of enriching it would let this plugin silently cancel another policy.
 * @param decision - the downstream decision.
 * @param message - the notice to prepend, or undefined to pass through.
 * @returns the decision, enriched when there is a notice.
 */
export function withNotice(decision, message) {
  if (message === undefined) return decision
  const existing = Array.isArray(decision?.additionalContexts) ? decision.additionalContexts : []
  const merged = [message, ...existing]
  if (decision?.kind === 'block') {
    return { kind: 'block', feedback: decision.feedback, additionalContexts: merged }
  }
  return { ...decision, additionalContexts: merged }
}

/**
 * `strict_gate_status`: the answer to "is this thing actually on, and what has
 * it been doing".
 *
 * A policy that runs silently is indistinguishable from a policy that is broken.
 * The three gates are configured from a YAML row the user edits by hand, so the
 * failure modes are mundane — a glob with a typo, an empty list where a list was
 * expected, a checker that never loaded — and none of them announce themselves.
 * This tool is where they become visible.
 *
 * @module @dsh-external/dsh-policy-strict-gate/status
 */

import { messageFactoryState } from './notify.js'

/** The model-facing tool name. */
export const TOOL_NAME = 'strict_gate_status'

/** Parameter schema, written directly as JSON Schema. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'targets'],
      description:
        'status reports whether each gate is active and the counters it has accumulated. targets lists the protected globs that compiled and reports whether a given path is protected.',
    },
    path: { type: 'string', description: 'For action=targets: report whether this path is protected, and by which rule.' },
  },
  required: ['action'],
}

/** Output schema: the canonical value every call returns. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    summary: { type: 'string' },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          gate: { type: 'string' },
          active: { type: 'boolean' },
          detail: { type: 'string' },
        },
      },
    },
    counters: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'summary', 'gates', 'counters', 'notes'],
}

/** The tool description the model reads. */
const DESCRIPTION = [
  'Report whether the strict gate is actually enforcing anything, and what it has done so far.',
  'Three gates exist: repeated-failure notices, the critical-path write gate, and the post-write syntax check. Each can be off — an empty criticalPaths list disables that gate entirely — and this tool is how that becomes visible instead of silent.',
  'Call it when a write was refused and the reason is unclear, or to check that the protection you configured is the protection in force.',
].join(' ')

/** Render the canonical value. */
function render(_args, value) {
  const lines = [value.summary]
  for (const note of value.notes) lines.push('· ' + note)
  lines.push('')
  for (const gate of value.gates) lines.push((gate.active ? '[on ] ' : '[off] ') + gate.gate + '  —  ' + gate.detail)
  if (value.counters.length > 0) {
    lines.push('')
    for (const counter of value.counters) lines.push('  ' + counter)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Register the tool.
 * @param tools - the `ctx.tools` registry.
 * @param gate - the running gate.
 * @param config - resolved configuration.
 * @param matcher - the compiled critical-path matcher.
 * @returns the disposer removing the tool.
 */
export function registerStatusTool(tools, gate, config, matcher) {
  const definition = {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'status'
      const notes = []

      if (action === 'targets') {
        const gates = [
          {
            gate: 'critical-path matcher',
            active: matcher.active,
            detail:
              matcher.rules.length +
              ' compiled rule(s) from ' +
              config.criticalPaths.length +
              ' configured glob(s)',
          },
        ]
        const counters = []
        const path = typeof args?.path === 'string' ? args.path.trim() : ''
        if (path !== '') {
          const match = matcher.match(path)
          counters.push('path: ' + path)
          counters.push('relative: ' + String(match.relative))
          counters.push(
            match.matched
              ? 'protected by `' + match.pattern + '` — a write needs an accepted Lean spec first'
              : 'not protected — writes to it are not gated',
          )
        } else {
          counters.push('no path given; pass path to test one')
        }
        if (config.criticalPaths.length !== matcher.rules.length) {
          notes.push(
            'Configured ' +
              config.criticalPaths.length +
              ' glob(s) but ' +
              matcher.rules.length +
              ' compiled; a glob with a brace group expands into several rules, and a glob that failed to compile was dropped with a warning at mount.',
          )
        }
        return {
          action,
          summary: matcher.active
            ? 'The critical-path gate has ' + matcher.rules.length + ' compiled rule(s).'
            : 'The critical-path gate is INACTIVE: criticalPaths is empty, so writes are not gated.',
          gates,
          counters,
          notes,
        }
      }

      const gates = [
        {
          gate: 'repeated failure',
          active: true,
          detail: 'notice at ' + config.repeatThreshold + ' repeats of one signature, then every ' + config.repeatCooldown,
        },
        {
          gate: 'critical paths',
          active: config.criticalPaths.length > 0 && matcher.active,
          detail:
            matcher.active
              ? matcher.rules.length + ' rule(s): ' + config.criticalPaths.join(', ')
              : 'criticalPaths is empty — writes are NOT gated',
        },
        {
          gate: 'post-write syntax',
          active: config.postWriteSyntax === true,
          detail: config.postWriteSyntax === true
            ? 'runs ' + [...(gate.checker?.checkable ?? [])].join(', ') + ' checks after each accepted write'
            : 'disabled by configuration',
        },
      ]
      const factory = messageFactoryState()
      const counters = [
        'failures observed: ' + gate.stats.failuresObserved,
        'repeat notices sent: ' + gate.stats.repeatNotices,
        'critical-path refusals: ' + gate.stats.refusals,
        'repair writes allowed through: ' + gate.stats.repairPasses,
        'spec checks run by the gate: ' + gate.stats.specChecks,
        'post-write checks run: ' + gate.stats.postWriteChecks,
      ]
      if (config.criticalPaths.length === 0) {
        notes.push(
          'To enable the critical-path gate, put a glob list in the plugin row: criticalPaths: [\'src/core/**\']. It is empty right now, so nothing is protected.',
        )
      }
      if (!factory.available) {
        notes.push('Notice channel is on the fallback path: ' + factory.problem)
      }
      if (gate.stats.refusals > 0 && gate.stats.repairPasses === 0) {
        notes.push(
          'Refusals happened with no repair write allowed through. If you are stuck, read one refusal verbatim — it names the spec path and the diagnostics.',
        )
      }
      const active = gates.filter((entry) => entry.active).length
      return {
        action: 'status',
        summary: active + ' of ' + gates.length + ' gates active.',
        gates,
        counters,
        notes,
      }
    },
  }
  return tools.register(definition)
}

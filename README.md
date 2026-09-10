<div align="center">

# Strict Gate

**A tool the model must remember to call is a tool it will skip exactly when it matters most.**

A DeepSeek Harness host plugin that turns `strict_check` and the failure journal
from things the agent *may* use into policy the harness *enforces*.

[![License: MIT](https://img.shields.io/badge/license-MIT-3DA639.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-tool%20plugin-4D6BFE.svg)](#install)
[![version](https://img.shields.io/github/package-json/v/catsenior507/dsh-policy-strict-gate?color=4D6BFE)](package.json)
[![node](https://img.shields.io/badge/node-%3E%3D20-3DA639.svg)](package.json)
[![stars](https://img.shields.io/github/stars/catsenior507/dsh-policy-strict-gate?color=4D6BFE)](https://github.com/catsenior507/dsh-policy-strict-gate/stargazers)

[English](README.md) · [简体中文](README.zh.md)

</div>

---

## The problem this solves

The previous two plugins gave the agent abilities. This one takes the decision to
use them away from the agent.

That is not a criticism of the agent — it is a statement about when checks get
skipped. Self-discipline fails precisely at the moments that matter: when the
model is confident, when it is rushing, and when it is already looping. Those are
the moments a check is worth most and the moments it is least likely to be invoked
voluntarily.

There is a second reason, and it is the one that convinced me to build this: **a
check whose output lands in a tool result can be skimmed. A check whose refusal
blocks the next write cannot.**

## The three gates

Each fails independently, is configured independently, and can be switched off
without touching the others.

### 1. Repeated failure

The same failure signature `repeatThreshold` times in one session (default 3)
queues a notice naming the failure class, the shipped remediation, and the
instruction to change something. After that it speaks again every
`repeatCooldown` repeats, so a long loop does not flood the context.

The harness already does this for *byte-identical* calls. This extends it to calls
that differ in whitespace or paths but fail for the same reason.

Counted on `tools/result` rather than `tools/post-execute` deliberately: the former
fires for **every** settled outcome, including the pipeline failures that bypass
post-execute — a denied call, an unknown tool, a call refused by this very gate. A
model hammering a refused call is exactly the loop worth breaking.

### 2. Critical paths

A write to a glob-protected path is **refused** until a Lean specification
covering it has been accepted.

Two design choices make this a policy rather than an obstruction:

**A refusal carries the diagnostics.** The harness discards a denied call's
would-be result, so a refusal that only said "blocked" would destroy the
information needed to satisfy it. Instead the gate runs the check *before*
refusing and quotes what it found.

**The repair path is always open.** A write that is fixing a diagnostic this gate
just reported is allowed through. Without that rule the gate deadlocks — it would
refuse the fix to the very error it is reporting, and there would be no way out.
This is `repairPasses` in the counters, and it is the single most important
behaviour in the plugin.

Three ways out of a refusal are printed with every one: satisfy the gate, retry
the repair, or remove the path from `criticalPaths`.

### 3. Post-write syntax

Every accepted write is followed immediately by the language's own check
(`py_compile`, `node --check`, the PowerShell parser), and the diagnostics ride
along as context for the next step.

This is the cheap tier that pays for itself most often: it catches the edit that
broke parsing **at the step that broke it**, instead of three commands later via
an unrelated failure.

<a id="install"></a>
## Install

The plugin is installed as a package into a dsh **profile**. `dsh plugin` forwards
to `pnpm` inside the profile directory, so any spec pnpm accepts works.

```bash
# from GitHub (the published form)
dsh plugin --profile web add github:catsenior507/dsh-policy-strict-gate

# a local checkout, while developing
dsh plugin --profile web add /absolute/path/to/dsh-policy-strict-gate
```

`web` is the shipped GUI profile; substitute `headless`, `sdk`, `acp`, or your own
profile name. On Windows, use forward slashes in a path.

For the critical-path and post-write gates, also install the checker it reasons
with:

```bash
dsh plugin --profile web add github:catsenior507/dsh-tool-strict-check
```

The gate locates that package by walking the DSH profile directories, so it works
whether the two are linked or installed separately — and if it is absent, the gate
says so and stands the two checking gates down rather than guessing.

Then **restart the host** and confirm with:

```
strict_gate_status action=status
```

### What install does *not* do

- **No build step** — the published JavaScript is the source; no `prepare` script
  runs.
- **No dependencies** — `dependencies` and `peerDependencies` are both empty.
- **`strict-check` is optional at load time.** Without it you still get the
  repeated-failure gate; you lose the other two.

Node.js 20 or newer.

## Enable the critical-path gate

It ships **off**, because the glob list is a statement about *your* code that no
plugin can guess. Until you set it, the other two gates still run.

`dsh plugin add` already inserted the plugin row. Add the list to that row's
`config` in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: policy-strict-gate
      name: '@dsh-external/dsh-policy-strict-gate'
      config:
        criticalPaths:
          - 'src/core/**'
          - 'src/**/*.spec.lean'
        protectedTools: ['write', 'edit']
        repeatThreshold: 3
        repeatCooldown: 3
        postWriteSyntax: true
        maxDiagnostics: 5
```

Ask `strict_gate_status action=targets path=<a file>` to confirm a path really is
protected and by which rule — a glob that silently fails to match is the most
likely way this gate ends up doing nothing while looking enabled.

### How a spec is found

For a protected target `src/core/x.ts`, the gate looks for, in order:

1. `src/core/x.spec.lean`
2. `src/core/x.ts.lean`
3. `src/core/specs/x.lean`

A `.lean` file is **never** refused by the gate, whatever the globs say — a spec is
how the gate is satisfied, so refusing to let one be written would make the gate
unsatisfiable.

## Introspection

`strict_gate_status` reports which gates are active, the compiled glob rules, and
the counters:

| Counter | Meaning |
| --- | --- |
| `failures observed` | Settled abnormal calls seen |
| `repeat notices sent` | "You are repeating yourself" notices delivered |
| `critical-path refusals` | Writes refused by the glob gate |
| `repair writes allowed through` | Refusals bypassed because the write was the fix |
| `spec checks run by the gate` | Lean checks the gate performed itself |

A policy that runs silently is indistinguishable from a policy that is broken, so
this tool exists to make the difference visible.

## Development

```bash
npm test        # 72 tests; the integration ones run the real Lean kernel
```

The integration tests drive the **real** collaborators rather than a stub, because
the failure they guard against is silent: two plugins that disagree about what
"verified" means would leave the gate refusing writes the model was told were fine.
`test/activation.test.js` goes further and drives the **real cordis waterfalls**,
because a listener registered on the wrong event name, or one that never calls
`next()`, throws nothing — it just makes the policy silently absent.

Four bugs worth remembering, all caught by tests rather than by review:

- **State keyed by object identity.** The state bag was a `WeakMap` keyed on the
  agent object. The harness hands a *different object* for the same agent to
  different hooks, so the gate learned a spec was accepted in one bag and looked
  for it in another — refusing forever. Now keyed by session id, bounded.
- **The subject of a spec was derived by string surgery.** `x.spec.lean` has stem
  `x`, but the real file is `x.ts`; recording `x` opened the repair window on a
  path no write can match. The subject is now resolved against the directory.
- **An unhandled rejection on unload.** The hooks attach from an async
  continuation, so a reload disposes the fiber before the collaborator import
  resolves; registering an effect then threw `cannot create effect on inactive
  context` **inside a floating promise**. That is a host-level fault caused by a
  plugin being unloaded, now guarded by asking the framework whether the fiber is
  still active.
- **A repeat notice cannot attach to the call that failed.** `tools/result` has no
  decision channel, so the notice is queued and delivered on the *next* call's
  `pre-execute`. Correct, but easy to mistake for a bug.

### Delivery, precisely

| Notice produced by | Reaches the model via | Delay |
| --- | --- | --- |
| `tools/result` (a failure) | queued → next call's `pre-execute` | one call |
| `tools/post-execute` (a write, a check) | that result's `additionalContexts` | none |
| a refusal | the `deny` reason text | immediate |

A denial has no `additionalContexts`, so anything queued for that step is appended
to the reason string instead — otherwise a refusal would silently swallow a repeat
notice produced by the very loop the refusal is part of.

| File | Role |
| --- | --- |
| `lib/index.js` | Mount, collaborator discovery, unload guard |
| `lib/gate.js` | The three gates and their decisions |
| `lib/matching.js` | Glob compilation, path extraction, spec-subject resolution |
| `lib/signature.js` | Failure identity and the remediation catalog |
| `lib/notify.js` | The one channel that reaches the model's next step |
| `lib/status.js` | `strict_gate_status` |

## License

MIT

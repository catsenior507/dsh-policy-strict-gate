/**
 * The gates.
 *
 * Three policies, one hook each, independently configurable — a bug in one
 * cannot silently disable another.
 *
 * **Repeated failure.** The complaint that started this work is not that the
 * agent fails, it is that it fails the *same way*. Counting signatures and
 * speaking up at a threshold is the smallest intervention that breaks the loop,
 * and it extends what the harness already does for byte-identical calls to calls
 * that differ in whitespace but fail for the same reason.
 *
 * **Critical paths.** A write to protected code is refused until a Lean
 * specification for it has been accepted. Two details make this enforceable
 * rather than obstructive:
 *
 * 1. A write that repairs a diagnostic this gate just reported is always
 *    allowed. Without that rule the gate deadlocks — it would refuse the fix to
 *    the very error it reported, with no way out.
 * 2. A refusal carries the current diagnostics. The harness discards a denied
 *    call's would-be result, so a refusal that only said "blocked" would destroy
 *    the information needed to satisfy it.
 *
 * **Post-write syntax.** Every accepted write is followed by the language's own
 * check, with the diagnostics injected. This is the cheap tier: it catches the
 * edit that broke parsing at the step that broke it, instead of three commands
 * later.
 *
 * The gate owns its verdict. It runs the Lean check itself with the same flags
 * `strict_check` uses rather than trying to observe that tool's result — a
 * plugin that inferred its own state from another plugin's output text would
 * break silently the moment either side's wording changed.
 *
 * @module @dsh-external/dsh-policy-strict-gate/gate
 */

import { existsSync } from 'node:fs'
import { classify, headLine, messageSignature, remediationFor } from './signature.js'
import { notice, withNotice } from './notify.js'
import { extractPath, isLeanSource, specCandidates, coveredTargets } from './matching.js'

/**
 * Per-agent counters and beliefs.
 *
 * Keyed by the agent's **session id**, not by the agent object.
 *
 * This was originally a `WeakMap` keyed on the object, which is the idiomatic
 * choice and was wrong: the harness hands a different object for the same agent
 * across hooks (`tools/result` carries one, `tools/pre-execute` another), so the
 * gate learned a spec was accepted in one bag and looked for it in another. The
 * observed symptom was a gate that refused a write, then refused it again after
 * a passing check, forever — the failure this gate exists to prevent, caused by
 * the gate.
 *
 * A session id is stable across every hook, which is the contract actually
 * needed. The cost is that the map does not empty by itself, so it is bounded.
 */
class AgentState {
  constructor() {
    /** signature → { count, lastNoticedAt, code, tool } */
    this.failures = new Map()
    /** spec path (absolute) → { at, clean, diagnostics, verdict, targets } */
    this.checks = new Map()
    /** target path (absolute) → diagnostics currently outstanding */
    this.outstanding = new Map()
    /** target (relative) → refusal count, for the status report */
    this.refusals = new Map()
  }
}

/** Sessions remembered at once. Beyond this the least recently used is dropped. */
const MAX_TRACKED_SESSIONS = 64

/**
 * The running policy.
 */
export class StrictGate {
  /**
   * @param {object} options - resolved config plus collaborators.
   */
  constructor(options) {
    /** Resolved configuration. */
    this.config = options.config
    /** Compiled critical-path matcher. */
    this.matcher = options.matcher
    /** Checker façade: `{ checkLean, checkLanguage, languageOf, checkable }`. */
    this.checker = options.checker
    /** Warning sink. */
    this.warn = typeof options.warn === 'function' ? options.warn : () => {}
    /** Per-session state, bounded; see {@link AgentState}. */
    this.agents = new Map()
    /** Notices awaiting the next model step. */
    this.pending = []
    /** Counters for the status tool. */
    this.stats = {
      refusals: 0,
      repairPasses: 0,
      postWriteChecks: 0,
      repeatNotices: 0,
      failuresObserved: 0,
      specChecks: 0,
    }
  }

  /**
   * The stable key for one execution.
   *
   * The session id is preferred because it is the identity that survives from
   * one hook to the next; the agent id is the fallback for an execution the loop
   * did not attach a session to.
   * @param exec - an execution, or a bare agent.
   * @returns the key, or null when neither identity is present.
   */
  keyFor(exec) {
    const agent = exec?.agent ?? exec
    const sessionId = agent?.session?.id
    if (typeof sessionId === 'string' && sessionId !== '') return 's:' + sessionId
    const agentId = agent?.id
    if (typeof agentId === 'string' && agentId !== '') return 'a:' + agentId
    return null
  }

  /** The state bag for one execution, created on first use. */
  stateFor(exec) {
    const key = this.keyFor(exec)
    if (key === null) return null
    let state = this.agents.get(key)
    if (state !== undefined) {
      // Refresh recency so the bounded map evicts idle sessions, not the one in
      // use.
      this.agents.delete(key)
      this.agents.set(key, state)
      return state
    }
    state = new AgentState()
    this.agents.set(key, state)
    while (this.agents.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.agents.keys().next()
      if (oldest.done === true) break
      this.agents.delete(oldest.value)
    }
    return state
  }

  /** How many sessions are being tracked; for diagnostics. */
  get trackedSessions() {
    return this.agents.size
  }

  /**
   * Install the hooks.
   * @param ctx - the cordis context.
   * @returns a disposer removing them.
   */
  attach(ctx) {
    if (typeof ctx?.on !== 'function') return () => {}
    const disposers = [
      ctx.on('tools/pre-execute', (exec, next) => this.preExecute(exec, next)),
      ctx.on('tools/post-execute', (exec, result, next) => this.postExecute(exec, result, next)),
      ctx.on('tools/result', (exec, result) => {
        try {
          this.observeResult(exec, result)
        } catch (error) {
          this.warn('[strict-gate] 统计失败记录时出错：' + String(error))
        }
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Best effort during unload.
        }
      }
    }
  }

  // ------------------------------------------------------------- delivery

  /**
   * Take the notices accumulated since the last step.
   *
   * Delivery happens on the *next* tool call, because that is the only moment
   * the harness offers a hook that runs before the model's next decision and is
   * guaranteed to run at all: `post-execute` is skipped for the pipeline
   * failures that bypass it, which is exactly the class of failure most worth
   * speaking up about.
   * @returns an array of messages, empty when there is nothing to say.
   */
  drain() {
    if (this.pending.length === 0) return []
    const messages = this.pending
    this.pending = []
    return messages
  }

  /** Queue one notice. */
  say(message) {
    if (message === undefined || message === null) return
    this.pending.push(message)
  }

  // ------------------------------------------------------------- gate: pre

  /**
   * The critical-path gate, plus delivery of whatever the last step produced.
   *
   * Runs before dispatch, so a refused call costs nothing and the refusal can
   * carry the diagnostics the caller needs to satisfy it.
   */
  async preExecute(exec, next) {
    const decision = await next()

    const messages = this.drain()
    let result = decision

    if (this.config.criticalPaths.length > 0 && this.matcher.active && decision?.kind !== 'deny') {
      if (this.isProtectedTool(exec)) {
        let verdict
        try {
          verdict = await this.evaluateTarget(exec)
        } catch (error) {
          // A gate that throws must not become a gate that lies. Report, allow.
          this.warn('[strict-gate] 关键路径判定失败，本次放行：' + String(error))
          verdict = { allowed: true }
        }
        if (!verdict.allowed) {
          this.stats.refusals += 1
          const state = this.stateFor(exec)
          if (state !== null) state.refusals.set(verdict.relative, (state.refusals.get(verdict.relative) ?? 0) + 1)
          // A denial has no `additionalContexts` channel — the model only ever
          // reads the reason string. Anything queued for this step is therefore
          // appended to it, or the refusal would silently swallow a repeat
          // notice produced by the very loop the refusal is part of.
          return { kind: 'deny', reason: [verdict.reason, ...messages.map(messageText)].filter(Boolean).join('\n\n') }
        }
      }
    }

    if (messages.length === 0) return result
    return attachContexts(result, messages)
  }

  /** Whether this tool's calls are treated as writes. */
  isProtectedTool(exec) {
    const tools = this.config.protectedTools
    if (!Array.isArray(tools) || tools.length === 0) return true
    return tools.includes(exec?.name)
  }

  /**
   * Decide whether one write to a protected path may proceed.
   * @param exec - the pending call.
   * @returns `{ allowed, relative, reason }`.
   */
  async evaluateTarget(exec) {
    const rawPath = extractPath(exec?.arguments)
    if (rawPath === null) return { allowed: true, relative: null, reason: '' }
    const absolute = this.matcher.absolutize(rawPath)
    const match = this.matcher.match(rawPath)
    if (!match.matched) return { allowed: true, relative: match.relative, reason: '' }

    // A spec is how the gate is satisfied, so writing one is never refused.
    if (isLeanSource(rawPath)) return { allowed: true, relative: match.relative, reason: '' }

    // A file that does not exist yet is an addition, not a modification of
    // reviewed code. The gate exists to stop silent *changes* to protected code.
    if (!existsSync(absolute)) return { allowed: true, relative: match.relative, reason: '' }

    const state = this.stateFor(exec)
    const outstanding = state?.outstanding.get(absolute)
    if (Array.isArray(outstanding) && outstanding.length > 0) {
      // Rule 1: the repair path is always open, or the gate deadlocks.
      this.stats.repairPasses += 1
      return { allowed: true, relative: match.relative, reason: '' }
    }

    const candidates = specCandidates(absolute)
    const verification = this.latestVerification(state, candidates)
    if (verification !== null && verification.clean) return { allowed: true, relative: match.relative, reason: '' }

    // Refuse, and do the work needed to make the refusal actionable.
    let diagnostics = verification?.diagnostics ?? []
    let source = verification === null ? null : verification.verdict
    if (source === null) {
      const probe = await this.checkCandidates(candidates)
      diagnostics = probe.diagnostics
      source = probe.source
      if (state !== null && probe.specPath !== null) {
        state.checks.set(this.matcher.absolutize(probe.specPath), {
          at: Date.now(),
          clean: false,
          diagnostics,
          verdict: source,
          targets: [absolute],
        })
      }
    }
    return {
      allowed: false,
      relative: match.relative,
      reason: this.refusalReason(match, candidates, diagnostics, source),
    }
  }

  /** The most recent recorded verdict for any spec candidate of one target. */
  latestVerification(state, candidates) {
    if (state === null) return null
    let best = null
    for (const candidate of candidates) {
      const record = state.checks.get(candidate)
      if (record === undefined) continue
      if (best === null || record.at > best.at) best = record
    }
    return best
  }

  /**
   * Check the first spec candidate that exists.
   * @param candidates - spec paths in preference order.
   * @returns `{ specPath, diagnostics, source }`.
   */
  async checkCandidates(candidates) {
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      this.stats.specChecks += 1
      const result = await this.checker.checkLean(candidate)
      return {
        specPath: candidate,
        diagnostics: errorLines(result.diagnostics, this.config.maxDiagnostics),
        source: result.verdict,
      }
    }
    return { specPath: null, diagnostics: [], source: 'no-spec' }
  }

  /** The refusal text: what was blocked, why, and the ways forward. */
  refusalReason(match, candidates, diagnostics, source) {
    const lines = [
      'strict-gate 拒绝写入 `' + match.relative + '`：它匹配受保护规则 `' + match.pattern + '`，' +
        '而本次会话中没有一份通过检查的 Lean 规格覆盖它。',
    ]
    if (source === 'no-spec') {
      lines.push('已查找的规格路径（都不存在）：')
      for (const candidate of candidates) lines.push('  ' + candidate)
    } else if (diagnostics.length > 0) {
      lines.push('规格当前未通过（' + source + '），诊断：')
      for (const diagnostic of diagnostics) lines.push('  ' + diagnostic)
    } else {
      lines.push('规格状态：' + String(source) + '。')
    }
    lines.push('')
    lines.push('三条出路：')
    lines.push('1. 先写规格（建议路径 `' + candidates[0] + '`），用 strict_check 验证到 accepted，然后重试这次写入。')
    lines.push('2. 如果这次写入正是在修上面列出的诊断，重试同样内容的写入即可放行——修复通道始终打开。')
    lines.push('3. 如果这个路径本就不该受保护，让用户把它从 criticalPaths 移除。不要绕过这道闸。')
    return lines.join('\n')
  }

  // ------------------------------------------------------------ gate: post

  /**
   * Post-dispatch: learn from an accepted check, and check what a write produced.
   *
   * Always calls `next()` first and enriches the decision, never replaces it —
   * another policy's block is not this plugin's to cancel.
   *
   * Notices produced here are returned on this very result rather than only
   * queued, so the model reads them one step earlier; the queue exists for the
   * notices that have no accepted call to ride.
   */
  async postExecute(exec, _result, next) {
    const learned = await this.learnCheck(exec)
    const downstream = await next()

    let written = null
    try {
      written = await this.checkWritten(exec, downstream)
    } catch (error) {
      this.warn('[strict-gate] 写后检查失败：' + String(error))
    }

    const messages = []
    if (learned !== null) {
      messages.push(learned)
      this.pending = this.pending.filter((message) => message !== learned)
    }
    if (written !== null) messages.push(written)
    if (messages.length === 0) return downstream
    return attachContexts(downstream, messages)
  }

  /**
   * Learn from a `strict_check` call by running the same check the tool ran.
   *
   * The verdict is derived here, from the spec file, rather than read out of the
   * tool's rendered output: this listener does not own that result, and parsing
   * another plugin's text would be a dependency that breaks quietly the moment
   * either side's wording changes. Re-running the check costs under a second on
   * a small spec and keeps the two halves honest about what "verified" means.
   * @returns a notice when a spec's status was recorded, else null.
   */
  async learnCheck(exec) {
    if (exec?.name !== 'strict_check') return null
    const args = exec.arguments ?? {}
    const specPath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : null
    if (specPath === null || !existsSync(specPath)) return null
    const state = this.stateFor(exec)
    if (state === null) return null

    this.stats.specChecks += 1
    const result = await this.checker.checkLean(specPath, { allowSorry: args.allowSorry === true })
    return this.recordVerdict(state, specPath, {
      clean: result.verdict === 'accepted',
      diagnostics: errorLines(result.diagnostics, this.config.maxDiagnostics),
      verdict: result.verdict,
    })
  }

  /**
   * Record one verdict against a spec path and the target it covers.
   *
   * The key is the **absolute** target path, because that is what both producers
   * can compute: `evaluateTarget` has the path the call will write, and
   * `learnCheck` has only the spec path. Keying on the workspace-relative form
   * in one place and the spec-derived form in the other meant a clean spec never
   * cleared the outstanding diagnostics that were blocking a write — the gate
   * would refuse forever with no way to satisfy it.
   * @returns a notice describing the change.
   */
  recordVerdict(state, specPath, verdict) {
    // The subject is resolved against the directory rather than derived by
    // string surgery: `x.spec.lean` covers `x.ts`, and a stem-only key would open
    // the repair window on `x` — a path no write can match, which is how the gate
    // ended up refusing the fix to the error it had just reported.
    const targets = coveredTargets(this.matcher.absolutize(specPath)).map((entry) => this.matcher.absolutize(entry))
    state.checks.set(this.matcher.absolutize(specPath), {
      at: Date.now(),
      clean: verdict.clean,
      diagnostics: verdict.diagnostics,
      verdict: verdict.verdict,
      targets,
    })
    if (verdict.clean) {
      for (const target of targets) state.outstanding.delete(target)
      return notice('strict-gate：规格 `' + specPath + '` 已通过检查。', 'strict-gate: ' + specPath + ' 通过')
    }
    // A failing spec opens the repair window on exactly the targets it covers.
    // This line is the difference between a policy and a deadlock: the gate
    // refuses the write, reports the error, and must then allow the fix to that
    // very error. Recorded diagnostics are both the reason shown and the key
    // that reopens the gate.
    for (const target of targets) state.outstanding.set(target, verdict.diagnostics)
    const lines = ['strict-gate：规格 `' + specPath + '` 未通过（' + verdict.verdict + '），诊断：']
    for (const diagnostic of verdict.diagnostics) lines.push('  ' + diagnostic)
    lines.push('在它通过之前，该受保护路径的**修复性**写入会被放行，其它改动会被拒绝。')
    return notice(lines.join('\n'), 'strict-gate: ' + specPath + ' 未通过')
  }

  /**
   * Check what an accepted write produced.
   * @returns a notice when the result is worth reporting, else null.
   */
  async checkWritten(exec, downstream) {
    if (this.config.postWriteSyntax !== true) return null
    if (downstream?.kind === 'block') return null
    if (!this.isProtectedTool(exec)) return null
    const path = extractPath(exec?.arguments)
    if (path === null || !existsSync(path)) return null
    const language = this.checker.languageOf(path)
    if (!this.checker.checkable.has(language)) return null

    this.stats.postWriteChecks += 1
    const result = await this.checker.checkLanguage(path, language)
    const diagnostics = errorLines(result.diagnostics, this.config.maxDiagnostics)

    if (result.verdict === 'unavailable') {
      return notice(
        'strict-gate：`' + path + '` 写入后**未能检查**（' + result.notes.join(' ') + '）。' +
          '没有证据说明它是好的——不要把它当成通过。',
        'strict-gate: ' + path + ' 未检查',
      )
    }
    if (diagnostics.length === 0) return null

    const state = this.stateFor(exec)
    if (state !== null) {
      // The absolute path is the key both producers agree on, so the repair
      // window opens for exactly the file this check was about.
      state.outstanding.set(this.matcher.absolutize(path), diagnostics)
    }
    const lines = [
      'strict-gate：写入 `' + path + '` 之后立即检查，' + result.tool + ' 报出 ' + diagnostics.length + ' 个错误：',
    ]
    for (const diagnostic of diagnostics) lines.push('  ' + diagnostic)
    lines.push('先修掉这些再继续下一步。带着编译错误往下写，后面每一步都建立在错的前提上。')
    return notice(lines.join('\n'), 'strict-gate: ' + path + ' 有 ' + diagnostics.length + ' 个错误')
  }

  // ------------------------------------------------------ gate: repetition

  /**
   * Count failures by signature and speak up when one recurs.
   *
   * Counting here rather than in `post-execute` is deliberate: `tools/result`
   * fires for every settled outcome, including the pipeline failures that bypass
   * `post-execute` — a denied call, an unknown tool, a call refused by this very
   * gate. A model hammering a refused call is exactly the loop worth breaking.
   */
  observeResult(exec, result) {
    if (result === null || typeof result !== 'object' || result.isError !== true) return
    const state = this.stateFor(exec)
    if (state === null) return
    this.stats.failuresObserved += 1

    const message = String(result.error?.message ?? '')
    const code = String(result.error?.info?.code ?? '') || classify(message)
    const signature = messageSignature(exec?.name, code, message)

    const seen = state.failures.get(signature) ?? { count: 0, lastNoticedAt: 0, code, tool: String(exec?.name ?? '?') }
    seen.count += 1
    seen.code = code
    state.failures.set(signature, seen)

    const threshold = this.config.repeatThreshold
    const due =
      seen.count === threshold || (seen.count > threshold && seen.count - seen.lastNoticedAt >= this.config.repeatCooldown)
    if (!due) return
    seen.lastNoticedAt = seen.count
    this.stats.repeatNotices += 1
    this.say(this.repeatNotice(exec, code, message, seen.count))
  }

  /** The "you are repeating yourself" text, with the shipped remediation. */
  repeatNotice(exec, code, message, count) {
    const tool = String(exec?.name ?? '?')
    const lines = [
      'strict-gate：`' + tool + '` 在本会话中已经以**同一种方式**失败 ' + count + ' 次（' + code + '）。',
      '最近一次：' + headLine(message),
    ]
    const hints = remediationFor(code)
    if (hints.length > 0) {
      lines.push('这一类失败的已知成因与做法：')
      for (const hint of hints) lines.push('  · ' + hint)
    }
    lines.push(
      '再重复一次同样的调用不会得到不同结果。至少要改一样东西：参数、工具、或先读取真实状态再动手。' +
        '完整记录见 failure_journal action=stats。',
    )
    return notice(lines.join('\n'), 'strict-gate: ' + tool + ' 已重复失败 ' + count + ' 次')
  }
}

/** Extract the error diagnostics as one-line strings, bounded. */
export function errorLines(diagnostics, limit) {
  const errors = (diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'error')
  const where = (diagnostic) =>
    diagnostic.file === ''
      ? String(diagnostic.line) + ':' + String(diagnostic.column)
      : diagnostic.file + ':' + diagnostic.line + ':' + diagnostic.column
  return errors.slice(0, limit).map((diagnostic) => where(diagnostic) + ' ' + headLine(diagnostic.message))
}

/**
 * The plain text of one queued message.
 *
 * A denial can only carry a string, so a deferred notice has to be flattened to
 * reach the model on that path.
 * @param message - a user-role message built by {@link notice}.
 * @returns its text content.
 */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * Attach messages to a decision without discarding it.
 *
 * `block` is preserved exactly — its `feedback` belongs to whichever listener
 * produced it — and every other decision keeps its fields while gaining the
 * contexts. Replacing the decision instead of enriching it would let this plugin
 * silently cancel another policy's work.
 */
export function attachContexts(decision, messages) {
  if (messages.length === 0) return decision
  const existing = Array.isArray(decision?.additionalContexts) ? decision.additionalContexts : []
  const merged = [...messages, ...existing]
  if (decision?.kind === 'block') {
    return { kind: 'block', feedback: decision.feedback, additionalContexts: merged }
  }
  return { ...decision, additionalContexts: merged }
}

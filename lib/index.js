/**
 * dsh-policy-strict-gate, host half.
 *
 * The two plugins before this one gave the agent abilities. This one takes the
 * decision to use them away from the agent.
 *
 * That is the whole point, and it is worth stating why a *policy* is needed when
 * a competent agent could simply call `strict_check`:
 *
 * - A tool the model must remember to call is a tool the model will skip exactly
 *   when it is most confident, most rushed, or already looping. Those are the
 *   moments the check matters and the moments self-discipline fails.
 * - A check whose output lands in a tool result can be skimmed. A check whose
 *   refusal blocks the next write cannot.
 *
 * So the three gates run whether or not anyone asks:
 *
 * 1. **Repetition.** The same failure signature `repeatThreshold` times in one
 *    session queues a notice naming the class, the shipped remediation, and the
 *    instruction to change something. The harness does this for byte-identical
 *    calls; this extends it to calls that differ in whitespace but fail for the
 *    same reason.
 * 2. **Critical paths.** A write to a glob-protected path is refused until a
 *    Lean specification covering it has been accepted. The refusal carries the
 *    live diagnostics, and a write that repairs a diagnostic the gate just
 *    reported always passes — a gate that could refuse the fix to its own error
 *    would be a deadlock, not a policy.
 * 3. **Post-write syntax.** An accepted write is followed immediately by the
 *    language's own check, so a broken edit surfaces at the step that broke it.
 *
 * Two properties are load-bearing and easy to get wrong:
 *
 * - **The gate owns its verdict.** It re-runs the Lean check rather than reading
 *   `strict_check`'s rendered output, so the two halves cannot drift and the
 *   gate keeps working if the strict-check plugin is not mounted at all.
 * - **A gate that throws allows the call.** Every failure path warns and stands
 *   down. A policy that bricks the session because of its own bug is worse than
 *   no policy, and the warning is where the bug gets found.
 *
 * @module @dsh-external/dsh-policy-strict-gate
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveConfig } from './config.js'
import { PathMatcher } from './matching.js'
import { StrictGate } from './gate.js'
import { probeMessageFactory, messageFactoryState } from './notify.js'
import { registerStatusTool } from './status.js'

/** Cordis plugin name. */
export const name = 'policy-strict-gate'

/**
 * `tools` is declared because two of the three gates are hooks on the tool
 * pipeline; without the service there is nothing to hook. Everything else is
 * reached through a guarded lookup, so a missing collaborator degrades one gate
 * instead of failing the mount.
 */
export const inject = ['tools']

/** Log through whichever channel this profile has. */
function makeLogger(ctx) {
  const logger = ctx?.logger
  return {
    info(message) {
      if (typeof logger?.info === 'function') logger.info(message)
    },
    warn(message) {
      if (typeof logger?.warn === 'function') logger.warn(message)
    },
  }
}

/**
 * Load the checker the gate reasons with.
 *
 * `@dsh-external/dsh-tool-strict-check` is an optional collaborator, not a
 * dependency: the gate must keep policing repetition and post-write syntax on a
 * profile that never installed it.
 *
 * Resolution is deliberately multi-path, because where the two packages sit
 * relative to each other differs between a development checkout and a profile
 * install, and a single-path import that fails turns two gates off silently.
 * Every candidate is an explicit base URL rather than a bare specifier, so
 * success never depends on which `node_modules` happens to be an ancestor of
 * this file.
 * @param log - the logger.
 * @param config - resolved gate configuration, forwarded to the checkers.
 * @returns a checker façade, or null when no checker could be loaded.
 */
async function loadChecker(log, config) {
  const strictCheck = await importCollaborator(log)
  if (strictCheck === null) return null

  if (typeof strictCheck.checkLean !== 'function' || typeof strictCheck.checkLanguage !== 'function') {
    log.warn('[strict-gate] strict-check 没有导出 checkLean/checkLanguage；两道检查闸停用（版本不匹配？）')
    return null
  }
  // The checker's own config defaults, with this plugin's timeout on top: the
  // gate is the one paying the wall clock, so it decides the budget.
  const base = typeof strictCheck.resolveCheckConfig === 'function' ? strictCheck.resolveCheckConfig({}) : {}
  const options = { ...base, timeoutMs: config.timeoutMs, maxOutputChars: 20_000 }
  return {
    checkLean: (path, extra) => strictCheck.checkLean(options, { path, ...(extra ?? {}) }),
    checkLanguage: (path, languageName) => strictCheck.checkLanguage(options, path, languageName),
    languageOf: strictCheck.languageOf,
    checkable: new Set(['python', 'javascript', 'typescript', 'powershell']),
  }
}

/** Package name and the file that must exist inside it. */
const COLLABORATOR = '@dsh-external/dsh-tool-strict-check'
const COLLABORATOR_ENTRY = 'lib/index.js'

/**
 * Import the collaborator from the first base that carries it.
 *
 * The search order runs from strongest signal to weakest: the DSH home the
 * process was told about, then any profile on disk, then this module's own
 * neighbourhood, then the working directory. `DSH_HOME` first matters because a
 * machine can have several profiles and only one of them may be the running one.
 *
 * Exported so a test can prove the collaborator is findable on this machine: the
 * resolution is the difference between two gates working and two gates silently
 * standing down, and it is the part most likely to break when plugin layout
 * changes.
 * @param log - the logger.
 * @returns the module namespace, or null.
 */
export async function importCollaborator(log) {
  const candidates = []

  const home = process.env['DSH_HOME']
  if (typeof home === 'string' && home.trim() !== '') candidates.push(join(home.trim(), 'profiles', 'web', 'node_modules'))

  try {
    const profilesDir = join(homedir(), '.dsh', 'profiles')
    for (const entry of readdirSync(profilesDir)) candidates.push(join(profilesDir, entry, 'node_modules'))
    candidates.push(join(profilesDir, 'node_modules'))
  } catch {
    // No profiles on this machine; the remaining candidates still apply.
  }

  candidates.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'))
  candidates.push(join(process.cwd(), 'node_modules'))

  const tried = []
  for (const base of candidates) {
    const entry = join(base, ...COLLABORATOR.split('/'), ...COLLABORATOR_ENTRY.split('/'))
    tried.push(entry)
    if (!existsSync(entry)) continue
    try {
      return await import(pathToFileURL(entry).href)
    } catch (error) {
      log.warn('[strict-gate] 找到 ' + entry + ' 但导入失败：' + String(error?.message ?? error))
    }
  }
  log.warn(
    '[strict-gate] 未找到 strict-check（' +
      COLLABORATOR +
      '）。关键路径闸与写后语法检查停用；重复失败提示仍然生效。已尝试：' +
      tried.join('、'),
  )
  return null
}

/**
 * Whether a context is still able to own new effects.
 *
 * Registering a tool or an effect on a disposed fiber throws
 * `cannot create effect on inactive context`. The gate reaches this state
 * legitimately: `loadChecker` is asynchronous, so a profile that reloads — or a
 * plugin unloaded while the collaborator was still being imported — resolves
 * into a context that is already gone. Without this guard the throw lands in a
 * floating promise, which surfaces as an unhandled rejection in the host rather
 * than as anything a reader can act on.
 *
 * The check asks the framework rather than reading `fiber.state`, because the
 * numeric enum is an internal mapping that would silently invert the meaning of
 * this predicate if it ever changed. `assertActive` is the rule the registry
 * itself applies before creating an effect, so asking it cannot disagree with
 * the answer that matters.
 * @param ctx - the plugin context.
 * @returns true when new registrations are still legal.
 */
function isContextLive(ctx) {
  if (ctx === undefined || ctx === null) return false
  const fiber = ctx.fiber
  if (fiber === undefined || fiber === null) return true
  if (typeof fiber.assertActive === 'function') {
    try {
      fiber.assertActive()
      return true
    } catch {
      return false
    }
  }
  if (typeof fiber.uid !== 'string') return false
  return true
}

/**
 * Mount the plugin.
 * @param ctx - the plugin cordis context.
 * @param config - optional `config:` block from the profile row.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const log = makeLogger(ctx)
  const root = process.cwd()

  const matcher = new PathMatcher(resolved.criticalPaths, root, (pattern, error) => {
    log.warn('[strict-gate] 无法编译 glob `' + pattern + '`，该规则已忽略：' + String(error))
  })

  // The message factory is probed once, before the first notice is needed: a
  // probe failure means notices fall back to a locally built message, and that
  // is worth reporting at mount rather than discovering later.
  void probeMessageFactory().then((factory) => {
    const state = messageFactoryState()
    if (factory === null) {
      log.warn('[strict-gate] 无法使用宿主消息工厂（' + state.problem + '）；改用本地构造的 notice。')
    }
  })

  void loadChecker(log, resolved).then((checker) => {
    if (checker === null) return
    // The import above is asynchronous, so this continuation can run after the
    // fiber was disposed (reload, shutdown, an unload race). Guarding here is
    // what keeps that from becoming an unhandled rejection in the host.
    if (!isContextLive(ctx)) {
      log.info('[strict-gate] 检查器加载完成时上下文已卸载，本次不挂载任何钩子。')
      return
    }
    const gate = new StrictGate({
      config: resolved,
      matcher,
      checker,
      warn: (message) => log.warn(message),
    })
    const detach = gate.attach(ctx)
    if (typeof ctx?.effect === 'function') ctx.effect(() => detach, 'strict-gate: gate hooks')

    if (resolved.criticalPaths.length > 0 && matcher.active) {
      log.info(
        '[strict-gate] 关键路径闸已启用，保护 ' + matcher.rules.length + ' 条规则：' +
          resolved.criticalPaths.join(', ') +
          '（命中路径的写入需要先有一份通过检查的 Lean 规格）',
      )
    } else {
      log.info(
        '[strict-gate] 关键路径闸未启用（criticalPaths 为空）：' +
          '重复失败提示与写后语法检查仍然生效。把关键路径写进插件配置即可开启。',
      )
    }
    if (resolved.postWriteSyntax === true) log.info('[strict-gate] 写后语法检查已启用')
    log.info('[strict-gate] 重复失败提示阈值：同一签名 ' + resolved.repeatThreshold + ' 次')

    if (resolved.exposeStatusTool !== true) return
    let tools
    try {
      tools = ctx.tools
    } catch {
      tools = undefined
    }
    if (tools === undefined || typeof tools.register !== 'function') return
    try {
      const dispose = registerStatusTool(tools, gate, resolved, matcher)
      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => dispose(), 'strict-gate: strict_gate_status tool')
      }
    } catch (error) {
      log.warn('[strict-gate] 注册 strict_gate_status 失败：' + String(error))
    }
  })
}

// Deliberately NO default export: cordis resolves a module plugin as
// module.default ?? module, so a default export would hide the named `inject`
// above and every `ctx.tools` read would fail with "cannot get property tools
// without inject".

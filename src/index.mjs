// dsh-work-continuity — function plugin entry。
//
// Work Continuity（CONTRACTS.md §5）：WorkState 与 User Memory 分库逻辑上分离。
// MVP：/checkpoint 命令显式持久化 goal/decisions/next_steps/artifacts，
//      human-checkable，不每 turn LLM 总结。
//
// 参考 memento 的 /memory 命令模式：commands 是可选的 host 服务，
// 缺失（headless）自动跳过。

import { createHash } from 'node:crypto'
import { openWorkStore, WORK_STATUSES } from './store.mjs'
import z from '@deepseek-ai/schemastery'

export const name = 'work-continuity'
export const inject = []
export const Config = z.object({
  workDir: z.string(),
  debug: z.boolean().default(false),
})

/** 设置页配置命名空间（2026-08-30：设置 → 插件 → 插件配置；settings.yaml 持久化） */
export const SETTINGS_NAMESPACE = 'work-continuity'

/**
 * settings 文档值合并进启动配置（settings 优先，缺失回退 Config 默认）。
 * 生效语义：设置页保存 → settings.yaml → 下次启动 apply 时覆盖（重启生效）。
 */
export function mergeSettingsIntoConfig(ctx, config) {
  let section = null
  try {
    const settings = ctx.get('settings')
    section = settings?.get?.(SETTINGS_NAMESPACE) ?? null
  } catch { /* settings 服务缺失 → 用 Config */ }
  if (!section || typeof section !== 'object') return { ...config }
  const merged = { ...config }
  for (const [key, value] of Object.entries(section)) {
    if (value !== undefined && value !== null) merged[key] = value
  }
  return merged
}

const USAGE = [
  'Usage: /checkpoint <verb> [args]',
  '  goal <text>         设置当前目标',
  '  decision <text>     记录一个决策',
  '  next <text>         添加下一步行动',
  '  artifact <path>     记录产物路径',
  '  unresolved <text>   记录未解决问题',
  '  status <planned|active|blocked|paused|done>  更新状态',
  '  focus <text>        设置当前焦点',
  '  done <n>            标记第 n 个下一步已完成',
  '  show                查看当前 WorkState',
  '  stats               使用统计（写入次数 / 完成率 / 各 scope 概览）',
  '  clear               清空（重置为初始状态）',
].join('\n')

/** 命令描述（en/zh） */
const COMMAND_DESCRIPTION = {
  en: {
    description: 'Manage the current work state (goal/decisions/next steps) for cross-session continuity',
    hint: '/checkpoint goal <goal> | decision <text> | next <text> | show',
  },
  zh: {
    description: '管理工作状态（目标/决策/下一步）以实现跨会话连续性',
    hint: '/checkpoint goal <目标> | decision <决策> | next <下一步> | show',
  },
}

export function apply(ctx, config = {}) {
  // 设置页（settings.yaml）优先于 cordis.patch.yml；apply 时一次性合并（重启生效）
  config = mergeSettingsIntoConfig(ctx, config)

  // --- 设置页 namespace 注册（2026-08-30：设置 → 插件 → 插件配置 tab）---
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, z.object({
      workDir: z.string(),
      debug: z.boolean(),
    }))
  })

  // M4 R2：workDir 必须显式（DSH_HOME 环境变量不可靠——正式实例踩坑记录）。
// 未配置时回退 DSH_HOME 并警告（fail-safe，但强烈建议显式配置）。
if (!config.workDir) {
  ctx.logger?.warn?.('[work-continuity] workDir 未显式配置，回退 $DSH_HOME/dsh-work-continuity——环境变量不可靠，请显式配置 workDir')
}
const store = openWorkStore({ dir: config.workDir })
  ctx.provide('work', createWorkService(store))

  registerCheckpointCommand(ctx, store, config)
  registerGoalAutoCapture(ctx, store)

  ctx.effect(() => () => {
    store.close()
  })
}

/**
 * P1-2（2026-09-02）：goal 工具事件 → 自动写 WorkState。
 *
 * 为什么要这个：审计发现 checkpoint 安装以来只有 1 次冒烟写入、7 天零使用——
 * 症结不是功能不好，是**要人记得敲命令**。外部实测教训同向：使用率低时该降低使用成本，
 * 而不是加功能。这里把「人记得敲」换成「系统自己捕捉」。
 *
 * 纪律：整段 fail-open（任何异常只 warn，不阻断 turn）；事件结构做多路径防御性取值；
 * 内容无变化不写（便宜门控，见 store.save 的 diff 判定）。
 */
function registerGoalAutoCapture(ctx, store) {
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event !== 'object') return
      const type = event.type ?? ''
      if (type !== 'tool/call' && type !== 'tool/result') return
      const data = event.data ?? {}
      const name = data.name ?? data.toolName ?? data.tool ?? data.call?.name ?? ''
      if (name !== 'create_goal' && name !== 'update_goal') return
      const args = data.args ?? data.input ?? data.arguments ?? data.call?.args ?? {}
      const objective = typeof args.objective === 'string' ? args.objective.trim() : ''
      const action = typeof args.action === 'string' ? args.action : ''
      const cwd = session?.cwd ?? (typeof ctx.get === 'function' ? ctx.get('session')?.cwd : undefined)
      const scopeId = scopeIdForCwd(cwd)
      const state = getStateCompat(store, scopeId) ?? {
        scopeId, goal: '', status: 'planned', decisions: [], checkpoints: [],
        unresolved: [], nextSteps: [], artifacts: [], completedSteps: [], handoff: null,
      }
      state.scopeId = scopeId
      let changed = false
      if (objective && state.goal !== objective) {
        state.goal = objective
        if (state.status === 'done') state.status = 'active'
        changed = true
      }
      if (action === 'complete' && state.status !== 'done') { state.status = 'done'; changed = true }
      if (action === 'blocked' && state.status !== 'blocked') { state.status = 'blocked'; changed = true }
      if (action === 'pause' && state.status !== 'paused') { state.status = 'paused'; changed = true }
      if (!changed) return
      store.save(state)
      store.appendAudit?.({ op: 'auto-goal', scopeId, detail: name + (action ? ':' + action : '') })
      ctx.logger?.info?.('[work-continuity] auto-captured work state from ' + name + (action ? ' (' + action + ')' : ''))
    } catch (err) {
      ctx.logger?.warn?.('[work-continuity] wc:degraded auto_goal_capture_failed reason='
        + (err instanceof Error ? err.message : String(err)))
    }
  })
}

/** ctx.work 服务：WorkState 读写 */
function createWorkService(store) {
  return {
    /** 读取当前 WorkState（无则 null） */
    get(scopeId, projectId) {
      return store.get({ scopeId, projectId })
    },
    /** 保存 WorkState（upsert） */
    save(input) {
      return store.save(input)
    },
  }
}

/**
 * 可选服务就绪即调用（对齐 dsh-memento 的 withService 模式）：
 * apply 时 commands 服务可能尚未提供（bundle 加载顺序），一次性 ctx.get 会静默跳过；
 * 必须订阅 internal/service 事件，等 commands 出现再注册（2026-08-27 正式实例实测教训）。
 */
function withService(ctx, serviceName, fn) {
  const existing = ctx.get(serviceName)
  if (existing !== undefined && existing !== null) {
    fn(existing)
    return
  }
  const off = ctx.on('internal/service', (name) => {
    if (name !== serviceName) return
    const service = ctx.get(serviceName)
    if (service !== undefined && service !== null) {
      off()
      fn(service)
    }
  })
}

/** /checkpoint 命令注册（commands 可选服务，缺失时等待其就绪） */
function registerCheckpointCommand(ctx, store, config) {
  withService(ctx, 'commands', (commands) => {
    if (!commands || typeof commands.register !== 'function') return
    commands.register({
      name: 'checkpoint',
      description: COMMAND_DESCRIPTION.en.description,
      input: { hint: COMMAND_DESCRIPTION.en.hint },
      handler: async (invocation) => {
        try {
          return handleCheckpoint(store, invocation, ctx)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: 'checkpoint error: ' + message }
        }
      },
    })
    ctx.logger?.info?.('[work-continuity] /checkpoint command registered')
  })
}

/** /checkpoint 处理器 */
async function handleCheckpoint(store, invocation, ctx) {
  const raw = String(invocation?.rawInput ?? '').trim()
  if (!raw) return { kind: 'success', text: USAGE }

  const [verb, ...rest] = raw.split(/\s+/)
  const arg = rest.join(' ').trim()
  const scopeId = scopeOf(invocation, ctx)

  const state = getStateCompat(store, scopeId) ?? {
    scopeId, goal: '', status: 'planned', decisions: [], checkpoints: [],
    unresolved: [], nextSteps: [], artifacts: [], completedSteps: [], handoff: null,
  }
  if (!Array.isArray(state.completedSteps)) state.completedSteps = []

  switch (verb) {
    case 'goal':
      if (!arg) return { kind: 'error', text: 'goal needs text: /checkpoint goal <goal>' }
      state.goal = arg
      state.status = state.status === 'done' ? 'active' : state.status
      saveWithTrace(store, state, ctx, verb)
      return { kind: 'success', text: `goal set: ${arg}` }

    case 'decision':
      if (!arg) return { kind: 'error', text: 'decision needs text: /checkpoint decision <text>' }
      state.decisions.push({ text: arg, evidenceIds: [] })
      saveWithTrace(store, state, ctx, verb)
      return { kind: 'success', text: `decision #${state.decisions.length} recorded` }

    case 'next':
      if (!arg) return { kind: 'error', text: 'next needs text: /checkpoint next <text>' }
      state.nextSteps.push(arg)
      saveWithTrace(store, state, ctx, verb)
      return { kind: 'success', text: `next step #${state.nextSteps.length} added` }

    case 'artifact':
      if (!arg) return { kind: 'error', text: 'artifact needs path: /checkpoint artifact <path>' }
      state.artifacts.push(arg)
      saveWithTrace(store, state, ctx, verb)
      return { kind: 'success', text: `artifact added: ${arg}` }

    case 'unresolved':
      if (!arg) return { kind: 'error', text: 'unresolved needs text: /checkpoint unresolved <text>' }
      state.unresolved.push(arg)
      saveWithTrace(store, state, ctx, verb)
      return { kind: 'success', text: `unresolved item added` }

    case 'status':
      if (!WORK_STATUSES.includes(arg)) {
        return { kind: 'error', text: `status must be one of: ${WORK_STATUSES.join(' | ')}` }
      }
      state.status = arg
      state.checkpoints.push({ timestamp: new Date().toISOString(), state: arg, evidenceIds: [] })
      saveWithTrace(store, state, ctx, verb)
      return { kind: 'success', text: `status -> ${arg}` }

    case 'focus':
      if (!arg) return { kind: 'error', text: 'focus needs text: /checkpoint focus <text>' }
      state.focus = arg
      saveWithTrace(store, state, ctx, verb)
      return { kind: 'success', text: `focus set: ${arg}` }

    case 'done': {
      // P1-3：完成率闭环——没有 done 就永远答不出"记下的下一步有多少真的做了"
      const idx = Number.parseInt(arg, 10)
      if (!Number.isInteger(idx) || idx < 1 || idx > state.nextSteps.length) {
        return { kind: 'error', text: 'done needs a valid index: /checkpoint done <1..' + state.nextSteps.length + '>' }
      }
      const [finished] = state.nextSteps.splice(idx - 1, 1)
      state.completedSteps.push({ text: finished, at: new Date().toISOString() })
      saveWithTrace(store, state, ctx, 'done')
      return { kind: 'success', text: 'done: ' + finished + '（剩余 ' + state.nextSteps.length + ' 项）' }
    }

    case 'stats':
      return { kind: 'success', text: renderStats(store) }

    case 'show':
      return { kind: 'success', text: renderWorkState(state) }

    case 'clear': {
      store.save({ scopeId, goal: '', status: 'planned', decisions: [], checkpoints: [], unresolved: [], nextSteps: [], artifacts: [], handoff: null })
      return { kind: 'success', text: 'work state cleared' }
    }

    default:
      return { kind: 'success', text: USAGE }
  }
}

/**
 * P1-2：保存 + 失败留痕。
 * 旧实现写失败只把错误文本返回给用户，无日志无审计——线上就是"悄悄没存上"。
 */
function saveWithTrace(store, state, ctx, op) {
  try {
    return store.save(state)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx?.logger?.warn?.('[work-continuity] wc:degraded save_failed op=' + op + ' scope=' + state.scopeId + ' reason=' + msg)
    try { store.appendAudit?.({ op: 'error', scopeId: state.scopeId, detail: op + ': ' + msg }) } catch { /* ignore */ }
    throw err
  }
}

/** P1-3：使用统计——直接回答「这功能被用了几次、有多少 next 真的完成了」 */
function renderStats(store) {
  const states = typeof store.list === 'function' ? store.list() : []
  const audit = typeof store.auditStats === 'function' ? store.auditStats(7) : []
  const totalNext = states.reduce((n, s) => n + (s.nextSteps?.length ?? 0), 0)
  const totalDone = states.reduce((n, s) => n + (s.completedSteps?.length ?? 0), 0)
  const rate = totalNext + totalDone > 0
    ? Math.round((totalDone / (totalNext + totalDone)) * 100) + '%'
    : 'n/a'
  const lines = [
    '[work] 使用统计',
    'WorkState 条数: ' + states.length,
    '下一步：待完成 ' + totalNext + ' / 已完成 ' + totalDone + '（完成率 ' + rate + '）',
    '最近 7 天审计: ' + (audit.length ? audit.map((a) => a.op + '=' + a.count).join(', ') : '（无记录）'),
  ]
  for (const s of states.slice(0, 5)) {
    lines.push('  · ' + s.scopeId + ' | ' + s.status + ' | v' + s.version
      + ' | goal: ' + (s.goal ? s.goal.slice(0, 40) : '(none)')
      + ' | next ' + (s.nextSteps?.length ?? 0) + ' | updated ' + new Date(s.updatedAt ?? Date.now()).toISOString().slice(0, 16))
  }
  return lines.join('\n')
}

/** 渲染 WorkState 为人类可读文本 */
function renderWorkState(state) {
  const lines = [
    `[work] status: ${state.status}`,
    state.goal ? `goal: ${state.goal}` : 'goal: (none)',
    state.focus ? `focus: ${state.focus}` : '',
  ]
  if (state.decisions.length) {
    lines.push('decisions:')
    state.decisions.forEach((d, i) => lines.push(`  ${i + 1}. ${d.text}`))
  }
  if (state.nextSteps.length) {
    lines.push('next steps:')
    state.nextSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
  }
  if (state.unresolved.length) {
    lines.push('unresolved:')
    state.unresolved.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
  }
  if (state.artifacts.length) {
    lines.push('artifacts:')
    state.artifacts.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`))
  }
  return lines.filter(Boolean).join('\n')
}

/**
 * 会话作用域：agent 会话 cwd 或默认 user-global。
 * 注意：不能直接读 ctx.session / invocation.agent.session —— cordis proxy 会抛
 * "cannot get property 'session' without inject"；用显式 ctx.get（同 withService）。
 */
function scopeOf(invocation, ctx) {
  const session = typeof ctx?.get === 'function' ? ctx.get('session') : undefined
  return scopeIdForCwd(session?.cwd)
}

/**
 * P1-2（2026-09-02）：scopeId 按 cwd 哈希。
 * 旧实现只返回 'workspace' / 'user-global' 两个常量 → **所有工作区共用一个桶**，
 * 而且旧数据落在 user-global 桶、新会话读 workspace 桶，show 出来是空的（作用域漂移）。
 */
export function scopeIdForCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return 'user-global'
  return 'ws:' + createHash('sha256').update(cwd.toLowerCase(), 'utf8').digest('hex').slice(0, 12)
}

/** 读 WorkState：新 scopeId 优先，回落旧常量桶（一次性兼容，不做破坏性迁移） */
function getStateCompat(store, scopeId) {
  const fresh = store.get({ scopeId })
  if (fresh) return fresh
  if (scopeId !== 'user-global') {
    const legacyWs = store.get({ scopeId: 'workspace' })
    if (legacyWs) return { ...legacyWs, scopeId }
    const legacyGlobal = store.get({ scopeId: 'user-global' })
    if (legacyGlobal) return { ...legacyGlobal, scopeId }
  }
  return null
}

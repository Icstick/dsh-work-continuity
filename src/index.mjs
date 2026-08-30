// dsh-work-continuity — function plugin entry。
//
// Work Continuity（CONTRACTS.md §5）：WorkState 与 User Memory 分库逻辑上分离。
// MVP：/checkpoint 命令显式持久化 goal/decisions/next_steps/artifacts，
//      human-checkable，不每 turn LLM 总结。
//
// 参考 memento 的 /memory 命令模式：commands 是可选的 host 服务，
// 缺失（headless）自动跳过。

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
  '  show                查看当前 WorkState',
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

  ctx.effect(() => () => {
    store.close()
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

  const state = store.get({ scopeId }) ?? {
    scopeId, goal: '', status: 'planned', decisions: [], checkpoints: [],
    unresolved: [], nextSteps: [], artifacts: [], handoff: null,
  }

  switch (verb) {
    case 'goal':
      if (!arg) return { kind: 'error', text: 'goal needs text: /checkpoint goal <goal>' }
      state.goal = arg
      state.status = state.status === 'done' ? 'active' : state.status
      store.save(state)
      return { kind: 'success', text: `goal set: ${arg}` }

    case 'decision':
      if (!arg) return { kind: 'error', text: 'decision needs text: /checkpoint decision <text>' }
      state.decisions.push({ text: arg, evidenceIds: [] })
      store.save(state)
      return { kind: 'success', text: `decision #${state.decisions.length} recorded` }

    case 'next':
      if (!arg) return { kind: 'error', text: 'next needs text: /checkpoint next <text>' }
      state.nextSteps.push(arg)
      store.save(state)
      return { kind: 'success', text: `next step #${state.nextSteps.length} added` }

    case 'artifact':
      if (!arg) return { kind: 'error', text: 'artifact needs path: /checkpoint artifact <path>' }
      state.artifacts.push(arg)
      store.save(state)
      return { kind: 'success', text: `artifact added: ${arg}` }

    case 'unresolved':
      if (!arg) return { kind: 'error', text: 'unresolved needs text: /checkpoint unresolved <text>' }
      state.unresolved.push(arg)
      store.save(state)
      return { kind: 'success', text: `unresolved item added` }

    case 'status':
      if (!WORK_STATUSES.includes(arg)) {
        return { kind: 'error', text: `status must be one of: ${WORK_STATUSES.join(' | ')}` }
      }
      state.status = arg
      state.checkpoints.push({ timestamp: new Date().toISOString(), state: arg, evidenceIds: [] })
      store.save(state)
      return { kind: 'success', text: `status -> ${arg}` }

    case 'focus':
      if (!arg) return { kind: 'error', text: 'focus needs text: /checkpoint focus <text>' }
      state.focus = arg
      store.save(state)
      return { kind: 'success', text: `focus set: ${arg}` }

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
  return session?.cwd ? 'workspace' : 'user-global'
}

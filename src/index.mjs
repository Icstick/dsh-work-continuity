// dsh-work-continuity — function plugin entry。
//
// Work Continuity（CONTRACTS.md §5）：WorkState 与 User Memory 分库逻辑上分离。
// MVP：/checkpoint 命令显式持久化 goal/decisions/next_steps/artifacts，
//      human-checkable，不每 turn LLM 总结。
//
// 参考 memento 的 /memory 命令模式：commands 是可选的 host 服务，
// 缺失（headless）自动跳过。

import { createHash, randomUUID } from 'node:crypto'
import { openWorkStore, WORK_STATUSES } from './store.mjs'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
  registerAutoCapture(ctx, store)
  registerWorkTool(ctx, store)
  registerWorkStateInjection(ctx, store)

  ctx.effect(() => () => {
    store.close()
  })
}

/**
 * P1-5（2026-09-02）：自动捕获从「goal 工具参数事件」升级为**权威域事件**。
 *
 * 为什么要升级：P1-2 监听 tool/call|tool/result 猜工具名（name=create_goal/update_goal），
 * 依赖事件负载里恰好带 args.objective/action——负载形状一变就静默失效（work_state 空转教训）。
 * 真实宿主在 goal 域每次 mutation 都会 append 权威事件 `goal/change`（data=GoalChangeMeta，
 * 含 operation + goal.objective + goal.phase），todo 域每次写入都会 append `todo/write`
 * （data.todos=[{content,status}]）——这两个事件**必然发生、形状稳定**，是可靠触发面。
 *
 * 触发语义（用户 2026-09-02 拍板：把门槛从「只有显式 goal」调低到这些节点）：
 *   1. `goal/change`（create/edit/pause/resume/complete/block/clear）→ 构想/长期目标/生命周期；
 *   2. `todo/write` 且未完成任务 ≥ 2 → 「工作进行到需要追踪的节点」（agent 已把构想拆成
 *      多步执行计划，且该 scope 尚无 WorkState）→ 自动建档（goal 留待 goal 事件或 /checkpoint
 *      goal 补充，nextSteps 取未完成任务，focus 取首个 in_progress/pending 任务）。
 *      已有 state 不覆盖（用户手记优先，避免 todo 每轮全量替换造成高频写库）。
 *
 * 纪律：整段 fail-open（任何异常只 warn，不阻断 turn）；事件结构做多路径防御性取值；
 * 内容无变化不写（便宜门控，见 store.save 的 diff 判定）。
 */
function registerAutoCapture(ctx, store) {
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event !== 'object') return
      const type = event.type ?? ''
      if (type === 'goal/change') {
        captureGoalChange(ctx, store, session, event.data ?? {})
      } else if (type === 'todo/write') {
        captureTodoWrite(ctx, store, session, event.data ?? {})
      }
    } catch (err) {
      ctx.logger?.warn?.('[work-continuity] wc:degraded auto_capture_failed reason='
        + (err instanceof Error ? err.message : String(err)))
    }
  })
}

/** goal/change（权威）：目标/构想/生命周期 → WorkState.goal/status。clear 清空 goal。 */
function captureGoalChange(ctx, store, session, data) {
  const operation = typeof data.operation === 'string' ? data.operation : ''
  const goal = data.goal && typeof data.goal === 'object' ? data.goal : {}
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : ''
  const phase = typeof goal.phase === 'string' ? goal.phase : ''
  const cwd = session?.cwd ?? (typeof ctx.get === 'function' ? ctx.get('session')?.cwd : undefined)
  const scopeId = scopeIdForCwd(cwd)
  const state = getStateCompat(store, scopeId) ?? {
    scopeId, goal: '', status: 'planned', decisions: [], checkpoints: [],
    unresolved: [], nextSteps: [], artifacts: [], completedSteps: [], handoff: null,
  }
  state.scopeId = scopeId
  let changed = false
  if (operation === 'clear') {
    if (state.goal !== '') { state.goal = ''; state.status = 'planned'; changed = true }
    if (!changed) return
    store.save(state)
    store.appendAudit?.({ op: 'auto-goal', scopeId, detail: 'goal/change:clear' })
    ctx.logger?.info?.('[work-continuity] auto-captured goal clear')
    return
  }
  if (objective && state.goal !== objective) {
    state.goal = objective
    changed = true
  }
  const status = phaseToStatus(phase)
  if (status && state.status !== status) { state.status = status; changed = true }
  if (state.goal && state.status === 'planned' && changed) { state.status = 'active'; changed = true }
  if (!changed) return
  store.save(state)
  store.appendAudit?.({ op: 'auto-goal', scopeId, detail: 'goal/change:' + operation + ':' + (phase || '') })
  ctx.logger?.info?.('[work-continuity] auto-captured goal from goal/change (' + operation + ')')
}

/** todo/write（权威）：多步任务计划 → 尚无 WorkState 时自动建档。 */
function captureTodoWrite(ctx, store, session, data) {
  const todos = Array.isArray(data.todos) ? data.todos : []
  const open = todos.filter((t) => t && typeof t === 'object'
    && typeof t.content === 'string' && t.content.trim()
    && t.status !== 'completed')
  if (open.length < 2) return // 单任务不构成「需要追踪的节点」
  const cwd = session?.cwd ?? (typeof ctx.get === 'function' ? ctx.get('session')?.cwd : undefined)
  const scopeId = scopeIdForCwd(cwd)
  const existing = getStateCompat(store, scopeId)
  if (existing) return // 已有 state：goal/change 与 /checkpoint 优先；todo 全量替换不覆盖手记
  const firstOpen = open[0].content.trim()
  const nextSteps = open.slice(0, 5).map((t) => t.content.trim())
  store.save({
    scopeId, goal: '', status: 'active', focus: firstOpen.slice(0, 200),
    decisions: [], checkpoints: [], unresolved: [], nextSteps,
    artifacts: [], completedSteps: [], handoff: null,
  })
  store.appendAudit?.({ op: 'auto-todo', scopeId, detail: 'todo/write:auto-create open=' + open.length })
  ctx.logger?.info?.('[work-continuity] auto-created work state from todo/write (open=' + open.length + ')')
}

/** goal phase → WorkState status（goal 域权威语义） */
function phaseToStatus(phase) {
  switch (phase) {
    case 'active': return 'active'
    case 'paused': return 'paused'
    case 'blocked': return 'blocked'
    case 'complete': return 'done'
    default: return ''
  }
}

/**
 * P1-6（2026-09-02）：把 checkpoint 的「触发判断」交给 LLM。
 *
 * 为什么：P1-5 的事件捕获只能覆盖「工具被调用的事实」（goal/change、todo/write），
 * 对话里自然语言提出的构想/节点没有结构化事件，事件驱动抓不到。用户拍板方向：
 * 「把 checkpoint 功能注入对话，让 LLM 决断」——两个机制：
 *   1. `work_state` 模型工具：goal/decision/next/artifact/unresolved/focus/status/done/
 *      show/clear，与 /checkpoint 同一 store 与渲染，LLM 自主决定何时记录；
 *   2. pre-step 注入紧凑 WorkState 摘要：该工作区有活跃 state 时每轮注入（~150 token），
 *      让 LLM 知道"正在追踪什么"，在节点主动更新。
 * 与 P1-5 互补：事件捕获兜底工具事实，LLM 判断覆盖自然语言内容。
 * 纪律：fail-open、无 state 不注入、done 不注入、注入预算受限、审计全留痕。
 */

/** 每个 verb 的帮助（工具 description 内联，避免模型瞎猜） */
const WORK_TOOL_ACTIONS = [
  'goal <text>', 'decision <text>', 'next <text>', 'artifact <path>',
  'unresolved <text>', 'focus <text>', 'status <planned|active|blocked|paused|done>',
  'done <n>', 'show', 'clear',
].join(' | ')

/** work_state 工具注册（tools 可选服务，缺失自动跳过——headless 无 tools） */
function registerWorkTool(ctx, store) {
  withService(ctx, 'tools', (tools) => {
    if (!tools || typeof tools.register !== 'function') return
    tools.register(defineTool({
      name: 'work_state',
      description: '跨会话工作状态（goal/decisions/next steps/artifacts/unresolved），'
        + '供后续会话续接工作。与 /checkpoint 命令同一数据。'
        + '当用户提出新构想/目标、工作进行到值得追踪的节点、或需要跨会话记住进度时调用；'
        + '琐碎单步不要记。action: ' + WORK_TOOL_ACTIONS,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['goal', 'decision', 'next', 'artifact', 'unresolved', 'focus', 'status', 'done', 'show', 'clear'],
          description: '要执行的操作：goal=设/改目标；decision=记录决策；next=加下一步；'
            + 'artifact=记录产物；unresolved=记录未决问题；focus=设当前焦点；'
            + 'status=更新状态；done=标记第 n 个 next 完成；show=查看当前状态；clear=清空',
        },
        text: {
          type: 'string',
          description: 'action 为 goal/decision/next/artifact/unresolved/focus 时的内容',
        },
        status: {
          type: 'string',
          enum: ['planned', 'active', 'blocked', 'paused', 'done'],
          description: 'action=status 时的目标状态',
        },
        index: {
          type: 'integer',
          description: 'action=done 时标记完成的 next 序号（从 1 开始）',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value && value.ok === false
            ? 'work_state error: ' + String(value.text ?? '')
            : String(value.text ?? ''),
        }],
      },
      async execute(args, exec) {
        try {
          exec?.signal?.throwIfAborted?.()
          const action = typeof args.action === 'string' ? args.action : ''
          // 组 rawInput，复用 handleCheckpoint（同一 store/渲染/审计）
          let raw = ''
          if (action === 'show' || action === 'clear' || action === 'status') {
            raw = action === 'status'
              ? 'status ' + String(args.status ?? '').trim()
              : action
          } else if (action === 'done') {
            const n = Number.parseInt(String(args.index ?? ''), 10)
            raw = Number.isInteger(n) && n > 0 ? 'done ' + n : 'done'
          } else {
            const text = typeof args.text === 'string' ? args.text.trim() : ''
            raw = text ? action + ' ' + text : action
          }
          const sessionCwd = exec?.agent?.session?.cwd
            ?? (typeof ctx.get === 'function' ? ctx.get('session')?.cwd : undefined)
          const toolCtx = {
            get: (name) => (name === 'session' ? { cwd: sessionCwd } : undefined),
            logger: ctx.logger,
          }
          const result = await handleCheckpoint(store, { rawInput: raw }, toolCtx)
          return { ok: result?.kind === 'success', text: String(result?.text ?? '') }
        } catch (err) {
          ctx.logger?.warn?.('[work-continuity] wc:degraded work_tool_failed reason='
            + (err instanceof Error ? err.message : String(err)))
          return { ok: false, text: 'work_state error: ' + (err instanceof Error ? err.message : String(err)) }
        }
      },
    }))
    ctx.logger?.info?.('[work-continuity] work_state tool registered')
  })
}

/** 注入预算：goal 80 / focus 60 / next 3×90 / decision 2×100 / unresolved 2×80 字符 */
const INJECT_GOAL_MAX = 80
const INJECT_FOCUS_MAX = 60
const INJECT_NEXT_MAX = 3
const INJECT_NEXT_CHARS = 90
const INJECT_DECISION_MAX = 2
const INJECT_DECISION_CHARS = 100
const INJECT_UNRESOLVED_MAX = 2
const INJECT_UNRESOLVED_CHARS = 80

/** 紧凑 WorkState 摘要（pre-step 注入用；空/全空返回 ''） */
function renderWorkStateBrief(state) {
  if (!state) return ''
  const lines = []
  const goal = String(state.goal ?? '').trim()
  const focus = String(state.focus ?? '').trim()
  const next = Array.isArray(state.nextSteps) ? state.nextSteps : []
  const decisions = Array.isArray(state.decisions) ? state.decisions : []
  const unresolved = Array.isArray(state.unresolved) ? state.unresolved : []
  if (!goal && !focus && next.length === 0 && decisions.length === 0 && unresolved.length === 0) return ''
  const head = []
  if (goal) head.push('goal: ' + truncateStr(goal, INJECT_GOAL_MAX))
  if (state.status && state.status !== 'planned') head.push('status: ' + state.status)
  if (focus) head.push('focus: ' + truncateStr(focus, INJECT_FOCUS_MAX))
  lines.push('[work-state] ' + head.join(' | '))
  if (next.length > 0) {
    lines.push('next: ' + next.slice(0, INJECT_NEXT_MAX).map((n) => truncateStr(String(n), INJECT_NEXT_CHARS)).join(' / '))
  }
  if (decisions.length > 0) {
    lines.push('decided: ' + decisions.slice(0, INJECT_DECISION_MAX)
      .map((d) => truncateStr(String(d?.text ?? ''), INJECT_DECISION_CHARS)).join(' / '))
  }
  if (unresolved.length > 0) {
    lines.push('open: ' + unresolved.slice(0, INJECT_UNRESOLVED_MAX)
      .map((u) => truncateStr(String(u), INJECT_UNRESOLVED_CHARS)).join(' / '))
  }
  lines.push('(work 状态可经 work_state 工具或 /checkpoint 更新)')
  return lines.join('\n')
}

function truncateStr(text, max) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** plugin user message（手写字面量，避免引入 dsh-llm 依赖；形状对齐 createUserMessage） */
function workStatePluginMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-work-continuity', form: 'work-state' },
  }
}

/**
 * pre-step 注入：该工作区有活跃 WorkState 时，每轮首步注入紧凑摘要 + work_state 提示。
 * fail-open：任何异常返回原决策/空决策，不阻断 turn（与 ACP composer 同范式）。
 */
function registerWorkStateInjection(ctx, store) {
  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
      if (payload?.step !== 1) return decision
      if (!decision || decision.kind !== 'enter') return decision
      const cwd = payload?.agent?.session?.cwd
        ?? (typeof ctx.get === 'function' ? ctx.get('session')?.cwd : undefined)
      const scopeId = scopeIdForCwd(cwd)
      const state = getStateCompat(store, scopeId)
      if (!state || state.status === 'done') return decision // 无 state / 已完成 → 不注入
      const body = renderWorkStateBrief(state)
      if (!body) return decision
      return { kind: 'enter', messages: [...decision.messages, workStatePluginMessage(body)] }
    } catch (err) {
      ctx.logger?.warn?.('[work-continuity] wc:degraded work_state_inject_failed reason='
        + (err instanceof Error ? err.message : String(err)))
      if (decision) return decision
      return { kind: 'enter', messages: [] }
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

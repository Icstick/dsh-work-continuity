// dsh-work-continuity — function plugin entry。
//
// Work Continuity（契约 CONTRACTS.md §5，见 my-plugins/acp-docs/）：WorkState 与 User Memory 分库逻辑上分离。
// MVP：/checkpoint 命令显式持久化 goal/decisions/next_steps/artifacts，
//      human-checkable，不每 turn LLM 总结。
//
// commands 是可选的 host 服务（服务就绪回调，见下方 withService），
// 缺失（headless）自动跳过。

import { createHash, randomUUID } from 'node:crypto'
import { openWorkStore, WORK_STATUSES, WorkStateVersionConflictError } from './store.mjs'
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
  '  status <planned|active|blocked|paused|in_review|done>  更新状态',
  '                      （in_review = 已交付待验收；done 只能由人类在此确认）',
  '  focus <text>        设置当前焦点',
  '  handoff <text>      写交接摘要（跨会话/跨 agent）',
  '  deadend <尝试> — <为何失败>  记录走过的死路与原因',
  '  done <n>            标记第 n 个下一步已完成',
  '  show                查看当前 WorkState',
  '  stats               使用统计（写入次数 / 完成率 / 各 scope 概览）',
  '  clear               清空（重置为初始状态）',
].join('\n')

/** /checkpoint 命令描述（中文——与 ACP 命令及 work_state 工具一致；宿主无 per-locale 选择机制） */
const COMMAND_DESCRIPTION = {
  description: '管理工作状态（目标/决策/下一步）以实现跨会话连续性',
  hint: '/checkpoint goal <目标> | decision <决策> | next <下一步> | handoff <交接> | show',
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
  // 未配置时回退 $DSH_HOME/dsh-work-continuity 并警告（fail-safe，但强烈建议显式配置）。
  if (!config.workDir) {
    ctx.logger?.warn?.('[work-continuity] workDir 未显式配置，回退 $DSH_HOME/dsh-work-continuity——环境变量不可靠，请显式配置 workDir')
  }
  const store = openWorkStore({ dir: config.workDir })
  ctx.provide('work', createWorkService(store))

  registerCheckpointCommand(ctx, store)
  registerAutoCapture(ctx, store)
  registerWorkTool(ctx, store)
  registerWorkStateSection(ctx)
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
  'unresolved <text>', 'focus <text>', 'handoff <text>', 'deadend <text>',
  'status <planned|active|blocked|paused|in_review>',
  'done <n>', 'show', 'export', 'clear',
].join(' | ')

/** work_state 工具注册（tools 可选服务，缺失自动跳过——headless 无 tools） */
function registerWorkTool(ctx, store) {
  withService(ctx, 'tools', (tools) => {
    if (!tools || typeof tools.register !== 'function') return
    tools.register(defineTool({
      name: 'work_state',
      description: '跨会话工作状态（goal/decisions/next steps/artifacts/unresolved/handoff），'
        + '供后续会话续接工作。与 /checkpoint 命令同一数据。'
        + '当用户提出新构想/目标、工作进行到值得追踪的节点、或需要跨会话记住进度时调用；'
        + '琐碎单步不要记。完成权分离：模型只能把目标推到 in_review，done 由人类确认。'
        + 'action: ' + WORK_TOOL_ACTIONS,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['goal', 'decision', 'next', 'artifact', 'unresolved', 'focus', 'handoff', 'deadend', 'status', 'done', 'show', 'export', 'clear'],
          description: '要执行的操作：goal=设/改目标；decision=记录决策；next=加下一步；'
            + 'artifact=记录产物；unresolved=记录未决问题；focus=设当前焦点；'
            + 'handoff=写交接摘要（跨会话/跨 agent）；deadend=记录走过的死路与原因；'
            + 'status=更新状态（只能到 in_review，done 需人类确认）；done=标记第 n 个 next 完成；'
            + 'show=查看当前状态；export=导出 md 快照；clear=清空',
        },
        text: {
          type: 'string',
          description: 'action 为 goal/decision/next/artifact/unresolved/focus 时的内容',
        },
        deadline: {
          type: 'string',
          description: 'action=next 时的截止时间（ISO 8601 或 YYYY-MM-DD），逾期不改期、保留原记录并写新原因',
        },
        deliverable: {
          type: 'string',
          description: 'action=next 时的交付物（可验收产物，完成判据=实测结果/文件而非口头自报）',
        },
        status: {
          type: 'string',
          enum: ['planned', 'active', 'blocked', 'paused', 'in_review'],
          description: 'action=status 时的目标状态。模型只能推到 in_review（已交付、待人类验收）；'
            + 'done 不可由模型设置——需人类执行 /checkpoint status done',
        },
        version: {
          type: 'integer',
          description: '可选。乐观并发：带上你读到的 WorkState version；若库中版本已变则拒绝写入'
            + '（返回 WC_STALE_VERSION，要求重读再写），避免并发静默覆盖',
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
          // 完成权分离（2026-09-09）：模型不得自报 done——只允许推到 in_review，done 由人类确认。
          // 枚举已排除 done，这里再挡一次（模型可能绕过 schema 描述）。
          if (action === 'status' && String(args.status ?? '').trim() === 'done') {
            return {
              ok: false,
              text: 'WC_COMPLETION_REQUIRES_HUMAN: 模型不能把目标置为 done。'
                + '请用 status=in_review 表示「已交付、待验收」，并确认 deliverable 已记录；'
                + 'done 只能由人类执行 /checkpoint status done 确认。',
            }
          }
          const sessionCwd = exec?.agent?.session?.cwd
            ?? (typeof ctx.get === 'function' ? ctx.get('session')?.cwd : undefined)
          // export：无副作用，直接渲染 md 快照（可落盘/进 git）
          if (action === 'export') {
            const sid = scopeIdForCwd(sessionCwd)
            const st = getStateCompat(store, sid)
            return { ok: true, text: renderWorkStateExport(st) }
          }
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
          const toolCtx = {
            get: (name) => (name === 'session' ? { cwd: sessionCwd } : undefined),
            logger: ctx.logger,
          }
          const expectedVersion = Number.isInteger(args.version) ? args.version : undefined
          const result = await handleCheckpoint(store, { rawInput: raw, expectedVersion }, toolCtx)
          // next + deadline/deliverable：补写 next_meta（与 next_steps 下标对齐，最后一项）
          if (action === 'next' && result?.kind === 'success'
              && (args.deadline !== undefined || args.deliverable !== undefined)) {
            try {
              const sid = scopeIdForCwd(sessionCwd)
              const st = store.get({ scopeId: sid })
              if (st && Array.isArray(st.nextSteps) && st.nextSteps.length > 0) {
                const meta = Array.isArray(st.nextMeta) ? [...st.nextMeta] : []
                while (meta.length < st.nextSteps.length) meta.push(null)
                const idx = st.nextSteps.length - 1
                const cur = (meta[idx] && typeof meta[idx] === 'object') ? { ...meta[idx] } : {}
                if (args.deadline !== undefined) cur.deadline = String(args.deadline).trim()
                if (args.deliverable !== undefined) cur.deliverable = String(args.deliverable).trim()
                meta[idx] = cur
                store.save({ scopeId: sid, nextMeta: meta })
              }
            } catch (metaErr) {
              ctx.logger?.warn?.('[work-continuity] wc:degraded next_meta_failed reason='
                + (metaErr instanceof Error ? metaErr.message : String(metaErr)))
            }
          }
          return { ok: result?.kind === 'success', text: String(result?.text ?? '') }
        } catch (err) {
          if (err instanceof WorkStateVersionConflictError) {
            // 版本冲突不是故障：告诉模型"重读再写"，且不要重试同一个 version
            return {
              ok: false,
              text: 'WC_STALE_VERSION: 版本冲突（库中 version=' + err.currentVersion + '，你带的是旧值）。'
                + '先 work_state show 重读，再用新的 version 重写；不要重试同一个 version。',
            }
          }
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
const INJECT_HANDOFF_CHARS = 100

/** 紧凑 WorkState 摘要（pre-step 注入用；空/全空返回 ''） */
export function renderWorkStateBrief(state) {
  if (!state) return ''
  const lines = []
  const goal = String(state.goal ?? '').trim()
  const focus = String(state.focus ?? '').trim()
  const next = Array.isArray(state.nextSteps) ? state.nextSteps : []
  const decisions = Array.isArray(state.decisions) ? state.decisions : []
  const unresolved = Array.isArray(state.unresolved) ? state.unresolved : []
  // 2026-09-09：handoff 单独存在时也要注入——交接摘要是跨会话续接的核心信息
  const ho = (state.handoff && typeof state.handoff === 'object') ? state.handoff : null
  if (!goal && !focus && next.length === 0 && decisions.length === 0 && unresolved.length === 0 && !ho?.summary) return ''
  const head = []
  if (goal) head.push('goal: ' + truncateStr(goal, INJECT_GOAL_MAX))
  if (state.status && state.status !== 'planned') head.push('status: ' + state.status)
  if (focus) head.push('focus: ' + truncateStr(focus, INJECT_FOCUS_MAX))
  lines.push(head.length > 0 ? '[work-state] ' + head.join(' | ') : '[work-state]')
  if (next.length > 0) {
    // T4 M4.5（2026-09-07）：next_meta 下标对齐渲染——deadline 附 (dl YYYY-MM-DD)，
    // 已过期附 ⚠ 标记（ISO 日期字典序比较；meta 缺失/越界/非对象 → 原样，不炸注入）
    const meta = Array.isArray(state.nextMeta) ? state.nextMeta : []
    const today = new Date().toISOString().slice(0, 10)
    lines.push('next: ' + next.slice(0, INJECT_NEXT_MAX).map((n, i) => {
      const base = truncateStr(String(n), INJECT_NEXT_CHARS)
      const m = meta[i]
      if (!m || typeof m !== 'object' || !m.deadline) return base
      const dl = String(m.deadline).trim().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dl)) return base
      return dl < today ? base + '（⚠ 逾期 ' + dl + '）' : base + '（dl ' + dl + '）'
    }).join(' / '))
  }
  if (decisions.length > 0) {
    lines.push('decided: ' + decisions.slice(0, INJECT_DECISION_MAX)
      .map((d) => truncateStr(String(d?.text ?? ''), INJECT_DECISION_CHARS)).join(' / '))
  }
  if (unresolved.length > 0) {
    lines.push('open: ' + unresolved.slice(0, INJECT_UNRESOLVED_MAX)
      .map((u) => truncateStr(String(u), INJECT_UNRESOLVED_CHARS)).join(' / '))
  }
  if (ho?.summary) lines.push('handoff: ' + truncateStr(String(ho.summary), INJECT_HANDOFF_CHARS))
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
    // 2026-09-10：删掉自造值 form:'work-state'。form 是官方语义词表
    // （instructions/catalog/snapshot/notice/relay/recall），不在表内的值会让
    // session-format 的 v2→v3 迁移拒收整条会话（本机 25 条历史会话因此打不开）。
    // 不声明 form 属官方默认（opaque 上下文行），渲染与未知 form 完全一致。
    source: { kind: 'plugin', plugin: 'dsh-work-continuity' },
  }
}

// --- S1-P7（2026-09-05，B9 v0.3 P7）：注入调度器接线（dsh-inject-scheduler，方案 A 主动上报）---
// 契约：调度器是可选项——缺失/故障只降级不阻断（WC 既有 fail-open 纪律延伸）；
// 段注册复用本文件 withService（internal/service 等就绪，已实证 cordis 4 兼容）；
// 上报 = 注入文本（renderWorkStateBrief 产物）生成后记录实际字符数。

/** 本插件在注入调度器注册表中的段 key */
export const WC_SECTION_KEY = 'wc.work_state'

/** 注册 wc.work_state 段（幂等；budgetChars=0=未设上限——WC 无 token 预算概念，截断全按字符） */
export function registerWorkStateSection(ctx) {
  withService(ctx, 'injectScheduler', (sched) => {
    if (!sched || typeof sched.registerSection !== 'function') return
    void sched.registerSection({
      key: WC_SECTION_KEY,
      plugin: 'dsh-work-continuity',
      order: 20,
      budgetChars: 0,
      unit: 'chars',
      refresh: 'per-turn',
    }).catch((err) => {
      ctx.logger?.warn?.('[work-continuity] section register failed: ' + (err instanceof Error ? err.message : String(err)))
    })
  })
}

/** 注入后上报实际注入量（fail-open：任何异常静默降级，绝不阻断注入与 turn） */
export function reportWorkStateUsage(ctx, sessionId, body) {
  try {
    if (typeof body !== 'string' || body.length === 0) return
    const sched = ctx.get('injectScheduler')
    if (!sched || typeof sched.recordUsage !== 'function') return
    void sched.recordUsage({
      ...(sessionId ? { sessionId } : {}),
      section: WC_SECTION_KEY,
      injectedChars: body.length,
    }).catch((err) => {
      ctx.logger?.warn?.('[work-continuity] usage report failed: ' + (err instanceof Error ? err.message : String(err)))
    })
  } catch (err) {
    ctx.logger?.warn?.('[work-continuity] usage report degraded: ' + (err instanceof Error ? err.message : String(err)))
  }
}

/**
 * pre-step 注入：该工作区有活跃 WorkState 时，每轮首步注入紧凑摘要 + work_state 提示。
 * fail-open：任何异常返回原决策/空决策，不阻断 turn（与 ACP composer 同范式）。
 */
function registerWorkStateInjection(ctx, store) {
  // 压缩后重锚（2026-09-09）：compaction 会把已经注入过的工作摘要从上下文里抹掉，
  // 而注入只在 step 1 发生——同轮后续步骤就再也看不到工作状态了（"Compaction Cliff"）。
  // 做法：监听 compaction/summary，把会话标记为待重锚；下一次 pre-step 无条件补注一次再清标记。
  const needsReanchor = new Set()
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'compaction/summary') return
      const sid = session?.id
      if (sid) needsReanchor.add(sid)
    } catch { /* fail-open：标记失败只是少一次重锚 */ }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    let decision
    try {
      decision = await next()
      const sessionId = payload?.agent?.session?.id ?? ''
      const reanchor = Boolean(sessionId) && needsReanchor.has(sessionId)
      if (payload?.step !== 1 && !reanchor) return decision
      if (!decision || decision.kind !== 'enter') return decision
      const cwd = payload?.agent?.session?.cwd
        ?? (typeof ctx.get === 'function' ? ctx.get('session')?.cwd : undefined)
      const scopeId = scopeIdForCwd(cwd)
      const state = getStateCompat(store, scopeId)
      if (!state || state.status === 'done') return decision // 无 state / 已完成 → 不注入
      const body = renderWorkStateBrief(state)
      if (!body) return decision
      // 重锚补注成功（或有 state 但无摘要）→ 清标记，避免每步重复注入
      if (reanchor && sessionId) needsReanchor.delete(sessionId)
      // S1-P7：实际注入发生 → 向调度器上报注入字符（fail-open）
      reportWorkStateUsage(ctx, sessionId, body)
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
 * 可选服务就绪即调用（host 服务异步装配，就绪回调）：
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
function registerCheckpointCommand(ctx, store) {
  withService(ctx, 'commands', (commands) => {
    if (!commands || typeof commands.register !== 'function') return
    commands.register({
      name: 'checkpoint',
      description: COMMAND_DESCRIPTION.description,
      input: { hint: COMMAND_DESCRIPTION.hint },
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
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: `goal set: ${arg}` }

    case 'decision':
      if (!arg) return { kind: 'error', text: 'decision needs text: /checkpoint decision <text>' }
      state.decisions.push({ text: arg, evidenceIds: [] })
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: `decision #${state.decisions.length} recorded` }

    case 'next':
      if (!arg) return { kind: 'error', text: 'next needs text: /checkpoint next <text>' }
      state.nextSteps.push(arg)
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: `next step #${state.nextSteps.length} added` }

    case 'artifact':
      if (!arg) return { kind: 'error', text: 'artifact needs path: /checkpoint artifact <path>' }
      state.artifacts.push(arg)
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: `artifact added: ${arg}` }

    case 'unresolved':
      if (!arg) return { kind: 'error', text: 'unresolved needs text: /checkpoint unresolved <text>' }
      state.unresolved.push(arg)
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: `unresolved item added` }

    case 'handoff': {
      // 2026-09-09：handoff 列此前"数据层留位、能力层为空"（最易误导下一个 agent 的死字段）。
      if (!arg) return { kind: 'error', text: 'handoff needs text: /checkpoint handoff <summary>' }
      const prev = (state.handoff && typeof state.handoff === 'object') ? state.handoff : {}
      state.handoff = { ...prev, summary: arg, updatedAt: new Date().toISOString() }
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: 'handoff recorded: ' + arg }
    }

    case 'deadend': {
      // 死路与原因：四段式交接里最有价值的一段——避免下一个会话重走已证伪的路径。
      if (!arg) return { kind: 'error', text: 'deadend needs text: /checkpoint deadend <尝试> — <为何失败>' }
      const prev = (state.handoff && typeof state.handoff === 'object') ? state.handoff : {}
      const deadends = Array.isArray(prev.deadends) ? [...prev.deadends] : []
      deadends.push({ text: arg, at: new Date().toISOString() })
      state.handoff = { ...prev, deadends, updatedAt: new Date().toISOString() }
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: 'deadend #' + deadends.length + ' recorded' }
    }

    case 'status':
      if (!WORK_STATUSES.includes(arg)) {
        return { kind: 'error', text: `status must be one of: ${WORK_STATUSES.join(' | ')}` }
      }
      state.status = arg
      state.checkpoints.push({ timestamp: new Date().toISOString(), state: arg, evidenceIds: [] })
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: `status -> ${arg}` }

    case 'focus':
      if (!arg) return { kind: 'error', text: 'focus needs text: /checkpoint focus <text>' }
      state.focus = arg
      saveWithTrace(store, state, ctx, verb, invocation?.expectedVersion)
      return { kind: 'success', text: `focus set: ${arg}` }

    case 'done': {
      // P1-3：完成率闭环——没有 done 就永远答不出"记下的下一步有多少真的做了"
      const idx = Number.parseInt(arg, 10)
      if (!Number.isInteger(idx) || idx < 1 || idx > state.nextSteps.length) {
        return { kind: 'error', text: 'done needs a valid index: /checkpoint done <1..' + state.nextSteps.length + '>' }
      }
      const [finished] = state.nextSteps.splice(idx - 1, 1)
      if (Array.isArray(state.nextMeta)) state.nextMeta.splice(idx - 1, 1)
      // P1-1（2026-09-07 审计）：done 同步 nextMeta——防后续 next+deadline/deliverable 按下标 length-1 补写串到旧条目
      state.completedSteps.push({ text: finished, at: new Date().toISOString() })
      saveWithTrace(store, state, ctx, 'done', invocation?.expectedVersion)
      return { kind: 'success', text: 'done: ' + finished + '（剩余 ' + state.nextSteps.length + ' 项）' }
    }

    case 'stats':
      return { kind: 'success', text: renderStats(store) }

    case 'show':
      return { kind: 'success', text: renderWorkState(state) }

    case 'clear': {
      // P1-2（2026-09-07 审计）：save 缺省字段回填 existing——必须显式清 focus/nextMeta/completedSteps
      const clearPayload = { scopeId, goal: '', status: 'planned', focus: null, decisions: [], checkpoints: [], unresolved: [], nextSteps: [], nextMeta: [], artifacts: [], completedSteps: [], handoff: null }
      if (invocation?.expectedVersion !== undefined) clearPayload.expectedVersion = invocation.expectedVersion
      store.save(clearPayload)
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
function saveWithTrace(store, state, ctx, op, expectedVersion) {
  try {
    return store.save(expectedVersion === undefined ? state : { ...state, expectedVersion })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (err instanceof WorkStateVersionConflictError) {
      // 版本冲突是"检测到的并发问题"，不是故障——单独记 op，便于 /checkpoint stats 观察
      try { store.appendAudit?.({ op: 'stale-version', scopeId: state.scopeId, detail: op + ': expected=' + expectedVersion + ' current=' + err.currentVersion }) } catch { /* ignore */ }
    } else {
      try { store.appendAudit?.({ op: 'error', scopeId: state.scopeId, detail: op + ': ' + msg }) } catch { /* ignore */ }
    }
    ctx?.logger?.warn?.('[work-continuity] wc:degraded save_failed op=' + op + ' scope=' + state.scopeId + ' reason=' + msg)
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
    state.nextSteps.forEach((s, i) => {
      const m = Array.isArray(state.nextMeta) ? state.nextMeta[i] : undefined
      const tag = m?.deadline ? '（截止 ' + m.deadline + '）' : ''
      const del = m?.deliverable ? ' [交付: ' + m.deliverable + ']' : ''
      lines.push('  ' + (i + 1) + '. ' + s + tag + del)
    })
  }
  if (state.unresolved.length) {
    lines.push('unresolved:')
    state.unresolved.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`))
  }
  if (state.artifacts.length) {
    lines.push('artifacts:')
    state.artifacts.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`))
  }
  const ho = (state.handoff && typeof state.handoff === 'object') ? state.handoff : null
  if (ho?.summary) lines.push('handoff: ' + ho.summary)
  if (Array.isArray(ho?.deadends) && ho.deadends.length) {
    lines.push('deadends（走过的死路与原因）:')
    ho.deadends.forEach((d, i) => lines.push(`  ${i + 1}. ${d?.text ?? ''}`))
  }
  return lines.filter(Boolean).join('\n')
}

/** 渲染 WorkState 为 Markdown 快照（action=export；可落盘/进 git 做 diff/review） */
export function renderWorkStateExport(state) {
  if (!state) return '(no work state)'
  const date = new Date().toISOString().slice(0, 10)
  const lines = [
    '# WorkState 快照（' + date + '）',
    '',
    '- scope: ' + state.scopeId + '  |  status: ' + state.status + '  |  version: ' + state.version,
    '',
    '## goal',
    state.goal || '（无）',
  ]
  if (state.focus) lines.push('', '## focus', state.focus)
  if (state.decisions?.length) {
    lines.push('', '## decisions')
    state.decisions.forEach((d, i) => lines.push(String(i + 1) + '. ' + (d?.text ?? '')))
  }
  if (state.nextSteps?.length) {
    lines.push('', '## next steps')
    state.nextSteps.forEach((s, i) => {
      const m = Array.isArray(state.nextMeta) ? state.nextMeta[i] : undefined
      let row = String(i + 1) + '. ' + s
      if (m?.deadline) row += '（截止 ' + m.deadline + '）'
      if (m?.deliverable) row += '  → 交付: ' + m.deliverable
      lines.push(row)
    })
  }
  if (state.artifacts?.length) {
    lines.push('', '## artifacts')
    state.artifacts.forEach((a, i) => lines.push(String(i + 1) + '. ' + a))
  }
  if (state.unresolved?.length) {
    lines.push('', '## open')
    state.unresolved.forEach((u, i) => lines.push(String(i + 1) + '. ' + u))
  }
  if (state.completedSteps?.length) {
    lines.push('', '## completed')
    state.completedSteps.forEach((c) => lines.push('- ' + (c?.text ?? '') + '（' + String(c?.at ?? '').slice(0, 10) + '）'))
  }
  const ho = (state.handoff && typeof state.handoff === 'object') ? state.handoff : null
  if (ho?.summary) lines.push('', '## handoff', ho.summary)
  if (Array.isArray(ho?.deadends) && ho.deadends.length) {
    lines.push('', '## deadends')
    ho.deadends.forEach((d) => lines.push('- ' + (d?.text ?? '')))
  }
  lines.push('', '_via dsh-work-continuity /checkpoint export_')
  return lines.join('\n')
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

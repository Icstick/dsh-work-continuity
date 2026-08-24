// dsh-work-continuity — function plugin entry (skeleton v0.1)
// WorkState 与 User Memory 分库逻辑上分离，但可共享 Evidence Ledger。
// MVP：/checkpoint 显式持久化 goal/decisions/open_questions/next_actions/artifacts。

export const name = 'work-continuity'
export const inject = []
export const Config = {}

export function apply(ctx) {
  // TODO(v0.1):
  // 1. /checkpoint 命令：显式保存 WorkState（human-checkable，不每 turn LLM 总结）
  // 2. session/event 投影 → goal/decision/artifact/status 检测（后台）
  // 3. 供 Context Composer 读取的 WorkState materialized view
}

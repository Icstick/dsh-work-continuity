// src/store.mjs — WorkState SQLite Provider（node:sqlite，零依赖）。
//
// WorkState 与 User Memory 分库逻辑上分离（CONTRACTS.md §5）：
// - 当前工作状态（goal/decisions/checkpoints/...）是 project state，
//   不应被向量 recall 的偶然相关度决定是否存在
// - MVP 只通过 /checkpoint 显式持久化（human-checkable，不每 turn LLM 总结）
//
// 存储：单表 work_state（scope_id + project_id 唯一），数组字段 JSON 序列化。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const PRAGMAS = 'PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_state (
  id            TEXT PRIMARY KEY,        -- hash(scope_id + project_id)
  scope_id      TEXT NOT NULL,
  project_id    TEXT NOT NULL DEFAULT '',
  goal          TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'planned',  -- planned/active/blocked/paused/done
  focus         TEXT,
  decisions     TEXT NOT NULL DEFAULT '[]',  -- JSON [{text, reason?, evidenceIds[]}]
  checkpoints   TEXT NOT NULL DEFAULT '[]',  -- JSON [{timestamp, state, evidenceIds[]}]
  unresolved    TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  next_steps    TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  artifacts     TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  handoff       TEXT,                        -- JSON {summary, nextAgentHints[]} | null
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_scope_project ON work_state (scope_id, project_id);

-- P1-3（2026-09-02）：可观测闭环。没有它答不出"这功能这周被用了几次、有多少 next 被完成"。
CREATE TABLE IF NOT EXISTS work_audit (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  op        TEXT NOT NULL,        -- save | skip-nochange | auto-goal | inject | error | done
  scope_id  TEXT NOT NULL DEFAULT '',
  detail    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_work_audit_ts ON work_audit (ts);
`

/** 状态枚举（CONTRACTS.md §5） */
export const WORK_STATUSES = Object.freeze(['planned', 'active', 'blocked', 'paused', 'done'])

/**
 * @param {object} opts
 * @param {string} [opts.dir] - 默认 $DSH_HOME/dsh-work-continuity
 * @returns {object} WorkState Provider 句柄
 */
export function openWorkStore(opts = {}) {
  const dir = opts.dir ?? path.join(process.env.DSH_HOME || '', 'dsh-work-continuity')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'work.db'))
  db.exec(PRAGMAS)
  db.exec(SCHEMA)
  // 迁移：completed_steps（P1-3 完成率闭环）。列已存在时 ALTER 抛错，忽略即可。
  try { db.exec("ALTER TABLE work_state ADD COLUMN completed_steps TEXT NOT NULL DEFAULT '[]'") } catch { /* 已迁移 */ }

  /** WorkState 键：scope_id + project_id */
  function keyOf(scopeId, projectId = '') {
    return `${scopeId}::${projectId}`
  }

  /**
   * 读取 WorkState（无则返回 null）。
   * @param {object} q - { scopeId, projectId? }
   * @returns {object|null}
   */
  function get({ scopeId, projectId = '' }) {
    const id = keyOf(scopeId, projectId)
    const row = db.prepare('SELECT * FROM work_state WHERE id = ?').get(id)
    return row ? toWorkState(row) : null
  }

  /**
   * 保存/创建 WorkState（upsert，version 递增）。
   * @param {object} input - { scopeId, projectId?, goal?, status?, focus?, decisions?, checkpoints?, unresolved?, nextSteps?, artifacts?, handoff? }
   * @returns {object} 保存后的 WorkState
   */
  function save(input) {
    if (input.status !== undefined && !WORK_STATUSES.includes(input.status)) {
      throw new TypeError(`status must be one of: ${WORK_STATUSES.join(' | ')}`)
    }
    const id = keyOf(input.scopeId, input.projectId ?? '')
    const existing = db.prepare('SELECT * FROM work_state WHERE id = ?').get(id)
    const now = Date.now()
    const version = existing ? existing.version + 1 : 1

    const payload = {
      id,
      scope_id: input.scopeId,
      project_id: input.projectId ?? '',
      goal: input.goal ?? existing?.goal ?? '',
      status: input.status ?? existing?.status ?? 'planned',
      focus: input.focus !== undefined ? input.focus : existing?.focus ?? null,
      decisions: JSON.stringify(input.decisions ?? JSON.parse(existing?.decisions ?? '[]')),
      checkpoints: JSON.stringify(input.checkpoints ?? JSON.parse(existing?.checkpoints ?? '[]')),
      unresolved: JSON.stringify(input.unresolved ?? JSON.parse(existing?.unresolved ?? '[]')),
      next_steps: JSON.stringify(input.nextSteps ?? JSON.parse(existing?.next_steps ?? '[]')),
      artifacts: JSON.stringify(input.artifacts ?? JSON.parse(existing?.artifacts ?? '[]')),
      completed_steps: JSON.stringify(input.completedSteps ?? JSON.parse(existing?.completed_steps ?? '[]')),
      handoff: input.handoff !== undefined ? JSON.stringify(input.handoff) : (existing?.handoff ?? null),
      version,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }

    // 便宜门控（2026-09-02）：内容无变化就不写、不涨 version、不动 updated_at。
    // 借鉴外部实测——把"每次触发都付出成本"变成"只有真变化才付出成本"。
    if (existing) {
      const same = existing.goal === payload.goal
        && existing.status === payload.status
        && (existing.focus ?? null) === (payload.focus ?? null)
        && existing.decisions === payload.decisions
        && existing.checkpoints === payload.checkpoints
        && existing.unresolved === payload.unresolved
        && existing.next_steps === payload.next_steps
        && existing.artifacts === payload.artifacts
        && (existing.completed_steps ?? '[]') === payload.completed_steps
        && (existing.handoff ?? null) === (payload.handoff ?? null)
      if (same) {
        appendAudit({ op: 'skip-nochange', scopeId: input.scopeId, detail: 'no field changed' })
        return toWorkState(existing)
      }
    }

    db.prepare(`
      INSERT OR REPLACE INTO work_state (
        id, scope_id, project_id, goal, status, focus, decisions, checkpoints,
        unresolved, next_steps, artifacts, completed_steps, handoff, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.id, payload.scope_id, payload.project_id, payload.goal, payload.status,
      payload.focus, payload.decisions, payload.checkpoints, payload.unresolved,
      payload.next_steps, payload.artifacts, payload.completed_steps, payload.handoff, payload.version,
      payload.created_at, payload.updated_at,
    )
    appendAudit({ op: 'save', scopeId: input.scopeId, detail: 'version=' + payload.version })
    return get({ scopeId: input.scopeId, projectId: input.projectId ?? '' })
  }

  /** P1-3：审计写入（自身失败不得影响主流程） */
  function appendAudit({ op, scopeId = '', detail = '' }) {
    try {
      db.prepare('INSERT INTO work_audit (ts, op, scope_id, detail) VALUES (?, ?, ?, ?)')
        .run(Date.now(), String(op), String(scopeId), String(detail).slice(0, 500))
    } catch { /* 审计失败不阻断 */ }
  }

  /** P1-3：全部 WorkState（stats 用） */
  function list() {
    return db.prepare('SELECT * FROM work_state ORDER BY updated_at DESC').all().map(toWorkState)
  }

  /** P1-3：审计统计（最近 N 天按 op 汇总） */
  function auditStats(days = 7) {
    const since = Date.now() - days * 86400000
    return db.prepare('SELECT op, COUNT(*) AS n FROM work_audit WHERE ts >= ? GROUP BY op ORDER BY n DESC')
      .all(since)
      .map((r) => ({ op: r.op, count: r.n }))
  }

  function close() { db.close() }

  return { db, get, save, close, list, appendAudit, auditStats }
}

function toWorkState(row) {
  return {
    id: row.id,
    scopeId: row.scope_id,
    projectId: row.project_id,
    goal: row.goal,
    status: row.status,
    focus: row.focus,
    decisions: JSON.parse(row.decisions),
    checkpoints: JSON.parse(row.checkpoints),
    unresolved: JSON.parse(row.unresolved),
    nextSteps: JSON.parse(row.next_steps),
    artifacts: JSON.parse(row.artifacts),
    completedSteps: JSON.parse(row.completed_steps ?? '[]'),
    handoff: row.handoff ? JSON.parse(row.handoff) : null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
// scripts/acp-candidate-pull.mjs — WC 侧「候选催办」拉取器（4.3 · ACP-B18，2026-09-24）
// ---------------------------------------------------------------------------
// 绑定设计：工作区 docs/plans/sync-boundary-protocol-20260922.md §7 —— 本文件是「写入=WC（唯一写者）」那一格。
//   ACP 侧只读导出（scripts/candidate-export.mjs）→ 本脚本拉取 → 写 WorkState 的 next_steps → 不回写 ACP。
//
// 五条纪律：
//   1. **走 openWorkStore**（WC 铁律 1 的合规入口），不裸写 SQL；
//   2. **只追加**：既有 nextSteps 原样保留，新条目 append 到尾部（绝不整份替换）；
//   3. **幂等**：按 next_steps 里既有的 [acp:<id>] 前缀判重，已存在即跳过 —— 重复拉取无副作用（§7 验收的前半）；
//   4. **不回写 ACP**（§7 明确不做回流，approve/reject 仍由人在 ACP 侧决定）；
//   5. **乐观并发**：save 带 expectedVersion，版本不一致即报错退出，绝不静默覆盖。
//
// 默认 dry-run（只报告会追加什么）。用法：
//   node scripts/acp-candidate-pull.mjs [--in <acp导出.jsonl>] [--scope <id>|--cwd <dir>] [--dir <workDir>] [--apply]
//   默认 --in = <DSH_HOME>/acp/candidate-export.jsonl

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { openWorkStore } from '../src/store.mjs'
import { scopeIdForCwd } from '../src/index.mjs'

const NL = String.fromCharCode(10)
const ACP_HINT_RE = /\[acp:(cand_[A-Za-z0-9_-]+)\]/

export function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) continue
    const next = argv[i + 1]
    a[k.replace(/^--/, '')] = next && !next.startsWith('--') ? next : '1'
  }
  return {
    in: a.in || '',
    scope: a.scope || '',
    cwd: a.cwd || '',
    dir: a.dir || '',
    apply: a.apply === '1' || a.apply === 'true',
  }
}

/** 从既有 nextSteps 里提取已拉取过的候选 id（判重键）。 */
export function existingAcpIds(nextSteps) {
  const out = new Set()
  for (const s of Array.isArray(nextSteps) ? nextSteps : []) {
    const m = ACP_HINT_RE.exec(String(s))
    if (m) out.add(m[1])
  }
  return out
}

/** 纯函数：算出「该追加什么」，不改任何东西。返回 { toAdd, skipped } */
export function planPull(records, nextSteps) {
  const have = existingAcpIds(nextSteps)
  const toAdd = []
  const skipped = []
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !r.id) continue
    if (have.has(r.id)) { skipped.push(r.id); continue }
    const hint = String(r.hint || '').trim()
    toAdd.push(hint || ('[acp:' + r.id + ']'))
    have.add(r.id)
  }
  return { toAdd, skipped }
}

/** 解析 ACP 导出的 JSONL（坏行容忍跳过） */
export function parseRecords(text) {
  const out = []
  for (const line of String(text || '').split(NL)) {
    const s = line.trim()
    if (!s) continue
    try { const o = JSON.parse(s); if (o && o.id) out.push(o) } catch { /* 坏行跳过 */ }
  }
  return out
}

const isMain = (() => {
  if (!process.argv[1]) return false
  return path.resolve(process.argv[1]).endsWith(path.join('scripts', 'acp-candidate-pull.mjs'))
})()

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const inFile = opts.in || path.join(home, 'acp', 'candidate-export.jsonl')
  if (!existsSync(inFile)) {
    console.error('[acp-pull] 找不到 ACP 导出：' + inFile)
    console.error('[acp-pull] 先跑 ACP 侧：node <acp>/scripts/candidate-export.mjs --out ' + inFile)
    process.exit(2)
  }
  const records = parseRecords(readFileSync(inFile, 'utf8'))
  const scopeId = opts.scope || scopeIdForCwd(opts.cwd || process.cwd())
  const store = openWorkStore(opts.dir ? { dir: opts.dir } : {})
  const state = store.get({ scopeId }) || { scopeId, nextSteps: [], version: 0 }
  const existing = Array.isArray(state.nextSteps) ? state.nextSteps : []
  const { toAdd, skipped } = planPull(records, existing)
  console.log('[acp-pull] 导出 ' + records.length + ' 条 · scope=' + scopeId + ' · 已有 next_steps ' + existing.length)
  console.log('[acp-pull] 已存在跳过 ' + skipped.length + ' · 待追加 ' + toAdd.length)
  for (const t of toAdd) console.log('    + ' + t)
  if (!opts.apply) { console.log('[acp-pull] dry-run（加 --apply 才写库）'); return }
  if (!toAdd.length) { console.log('[acp-pull] 无新增 —— 不写库（幂等，§7 验收）'); return }
  try {
    const saved = store.save({
      scopeId,
      nextSteps: [...existing, ...toAdd],
      expectedVersion: state.version,
    })
    console.log('[acp-pull] 已写：next_steps ' + existing.length + ' → ' + saved.nextSteps.length + ' · version ' + saved.version)
  } catch (err) {
    console.error('[acp-pull] 写库失败（并发冲突时不覆盖）：' + String(err && err.message))
    process.exit(3)
  }
}

if (isMain) main()

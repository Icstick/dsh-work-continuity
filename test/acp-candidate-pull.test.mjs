// test/acp-candidate-pull.test.mjs — WC 侧「候选催办」拉取器（4.3 · ACP-B18，2026-09-24）
// 验收目标：只追加不覆盖、幂等（重复拉取条数不变 —— §7 验收前半）、坏输入容忍、dry-run 不写库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkStore } from '../src/store.mjs'
import { parseArgs, existingAcpIds, planPull, parseRecords } from '../scripts/acp-candidate-pull.mjs'

test('parseArgs：默认 dry-run（apply=false），--apply / --in / --scope 识别', () => {
  const a = parseArgs([])
  assert.equal(a.apply, false)
  assert.equal(a.in, '')
  assert.equal(a.scope, '')
  const b = parseArgs(['--apply', '--in', 'x.jsonl', '--scope', 'ws:abc'])
  assert.equal(b.apply, true)
  assert.equal(b.in, 'x.jsonl')
  assert.equal(b.scope, 'ws:abc')
})

test('existingAcpIds：只认 [acp:cand_*]，手工条目一律不算', () => {
  const ids = existingAcpIds([
    '手工条目 A',
    '[acp:cand_abc123] style · 证据 1 条 · proposed',
    '前言 [acp:cand_def456] 后缀',
    '[acp:obs_notacand] 不该被算作候选',
  ])
  assert.deepEqual([...ids].sort(), ['cand_abc123', 'cand_def456'])
  assert.deepEqual([...existingAcpIds(undefined)], [])
})

test('planPull：新条目追加、已存在跳过、同批重复只加一次', () => {
  const records = [
    { id: 'cand_1', hint: '[acp:cand_1] style · 证据 1 条 · proposed' },
    { id: 'cand_2', hint: '[acp:cand_2] work · 证据 2 条 · proposed' },
    { id: 'cand_1', hint: '[acp:cand_1] 同批重复' },
    { id: 'cand_3' },
  ]
  const p = planPull(records, ['[acp:cand_2] 已经在了'])
  // skipped = 「没被加进去的」：既有桶里的 cand_2 + 同批内第二次出现的 cand_1
  assert.equal(p.skipped.length, 2)
  assert.equal(p.skipped[0], 'cand_2')
  assert.equal(p.skipped[1], 'cand_1')
  assert.equal(p.toAdd.length, 2)
  assert.equal(p.toAdd[0], '[acp:cand_1] style · 证据 1 条 · proposed')
  assert.equal(p.toAdd[1], '[acp:cand_3]')
  assert.deepEqual(planPull(null, null), { toAdd: [], skipped: [] })
})

test('parseRecords：坏行 / 空行 / 无 id 行一律容忍跳过', () => {
  const text = [
    '{"id":"cand_1","hint":"a"}',
    '',
    'not json at all',
    '{"noId":true}',
    '{"id":"cand_2","hint":"b"}',
  ].join(String.fromCharCode(10))
  assert.deepEqual(parseRecords(text).map((r) => r.id), ['cand_1', 'cand_2'])
  assert.deepEqual(parseRecords(''), [])
})

test('端到端：只追加不覆盖 + 重复拉取幂等（§7 验收前半）', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-acppull-'))
  const store = openWorkStore({ dir })
  // 先关连接再删目录：SQLite 句柄未关时 rmSync 会 EPERM（Windows 文件锁）
  t.after(() => {
    try { store.close() } catch { /* 已关 */ }
    rmSync(dir, { recursive: true, force: true })
  })
  const scopeId = 'ws:test123'
  store.save({ scopeId, nextSteps: ['手工条目 A', '手工条目 B'] })

  const records = [
    { id: 'cand_x1', hint: '[acp:cand_x1] style · 证据 1 条 · proposed' },
    { id: 'cand_x2', hint: '[acp:cand_x2] work · 证据 3 条 · proposed' },
  ]

  let st = store.get({ scopeId })
  const p1 = planPull(records, st.nextSteps)
  assert.equal(p1.toAdd.length, 2)

  store.save({ scopeId, nextSteps: [...st.nextSteps, ...p1.toAdd], expectedVersion: st.version })
  st = store.get({ scopeId })
  assert.equal(st.nextSteps.length, 4)
  assert.deepEqual(st.nextSteps.slice(0, 2), ['手工条目 A', '手工条目 B'])

  // 幂等：同一批再拉 N 次，next_steps 条数不变（且不写库）
  for (let i = 0; i < 3; i += 1) {
    const p = planPull(records, store.get({ scopeId }).nextSteps)
    assert.equal(p.toAdd.length, 0)
    assert.equal(p.skipped.length, 2)
  }
  assert.equal(store.get({ scopeId }).nextSteps.length, 4)

  // 追加第三批时，仍不动前 4 条
  st = store.get({ scopeId })
  const p3 = planPull([{ id: 'cand_x3', hint: '[acp:cand_x3] external_fact · 证据 1 条 · proposed' }], st.nextSteps)
  store.save({ scopeId, nextSteps: [...st.nextSteps, ...p3.toAdd], expectedVersion: st.version })
  const fin = store.get({ scopeId })
  assert.equal(fin.nextSteps.length, 5)
  assert.deepEqual(fin.nextSteps.slice(0, 4), st.nextSteps)
})

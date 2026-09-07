// test/golden-regression.test.mjs — 黄金回归集：历史契约防复发（P0，2026-09-07）。
// 语义锚点：checkpoint/work_state 快照完整性 —— 任何一次"写状态覆盖旧字段"类改动
// 都会在这里红。
//   W1 全字段快照往返一致（goal/decisions/nextSteps/status/version）
//   W2 版本单调递增（防重复/回跳）
//   W3 局部 save 保留已有字段（防覆盖丢 decisions/nextSteps）
//   W4 scope/project 隔离（防串会话/串项目）
//   W5 状态枚举契约（planned/active/blocked/paused/done）
//   W6 调度器 section 契约导出存在（防误删接线）
// 运行：node --test test/golden-regression.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openWorkStore } from '../src/store.mjs'
import { WC_SECTION_KEY, registerWorkStateSection, scopeIdForCwd, renderWorkStateExport } from '../src/index.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wc-golden-'))
  const store = openWorkStore({ dir })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store
}

test('W1 全字段快照往返一致（防字段丢失回归）', (t) => {
  const store = fresh(t)
  const saved = store.save({
    scopeId: 'workspace', projectId: 'golden',
    goal: '黄金回归集落地', status: 'active',
    decisions: [{ text: '锚定 store 契约', evidenceIds: ['ev_x'] }],
    nextSteps: ['跑全量', '合并'],
  })
  const got = store.get({ scopeId: 'workspace', projectId: 'golden' })
  assert.equal(got.goal, '黄金回归集落地')
  assert.equal(got.status, 'active')
  assert.equal(got.decisions.length, 1)
  assert.deepEqual(got.decisions[0].evidenceIds, ['ev_x'])
  assert.deepEqual(got.nextSteps, ['跑全量', '合并'])
  assert.equal(saved.version, got.version)
})

test('W2 版本单调递增（防覆盖写回跳）', (t) => {
  const store = fresh(t)
  let v = 0
  for (let i = 1; i <= 5; i++) {
    const s = store.save({ scopeId: 's', goal: 'v' + i })
    assert.equal(s.version, i)
    assert.ok(s.version > v)
    v = s.version
  }
})

test('W3 局部 save 保留已有字段（防 checkpoint 覆盖丢数据）', (t) => {
  const store = fresh(t)
  store.save({ scopeId: 's', goal: 'g', decisions: [{ text: 'd1' }], nextSteps: ['n1'] })
  // 只改 status（checkpoint 典型路径）→ goal/decisions/nextSteps 必须都在
  const updated = store.save({ scopeId: 's', status: 'paused' })
  assert.equal(updated.goal, 'g')
  assert.equal(updated.status, 'paused')
  assert.equal(updated.decisions.length, 1)
  assert.deepEqual(updated.nextSteps, ['n1'])
})

test('W4 scope/project 隔离（防跨会话串写）', (t) => {
  const store = fresh(t)
  store.save({ scopeId: 'ws1', goal: 'A' })
  store.save({ scopeId: 'ws2', goal: 'B' })
  store.save({ scopeId: 'ws1', projectId: 'p2', goal: 'C' })
  assert.equal(store.get({ scopeId: 'ws1' }).goal, 'A')
  assert.equal(store.get({ scopeId: 'ws2' }).goal, 'B')
  assert.equal(store.get({ scopeId: 'ws1', projectId: 'p2' }).goal, 'C')
  assert.equal(store.get({ scopeId: 'ws3' }), null)
})

test('W5 状态枚举契约（planned/active/blocked/paused/done）', (t) => {
  const store = fresh(t)
  for (const st of ['planned', 'active', 'blocked', 'paused', 'done']) {
    const s = store.save({ scopeId: 's', goal: 'g', status: st })
    assert.equal(s.status, st)
  }
  assert.throws(() => store.save({ scopeId: 's', status: 'invalid' }), /status must be one of/)
})

test('W6 调度器 section 接线导出存在（防误删契约）', () => {
  assert.equal(typeof WC_SECTION_KEY, 'string')
  assert.ok(WC_SECTION_KEY.length > 0)
  assert.equal(typeof registerWorkStateSection, 'function')
  assert.equal(typeof scopeIdForCwd, 'function')
})
test('W7 nextMeta 与 nextSteps 下标对齐存取（deadline/deliverable 防丢）', (t) => {
  const store = fresh(t)
  store.save({ scopeId: 's', goal: 'g', nextSteps: ['任务一', '任务二'] })
  const upd = store.save({ scopeId: 's', nextMeta: [{ deadline: '2026-09-10', deliverable: '报告.md' }, null] })
  assert.equal(upd.nextSteps.length, 2)
  assert.deepEqual(upd.nextMeta[0], { deadline: '2026-09-10', deliverable: '报告.md' })
  assert.equal(upd.nextMeta[1], null)
  const again = store.save({ scopeId: 's', status: 'active' })
  assert.deepEqual(again.nextMeta[0], { deadline: '2026-09-10', deliverable: '报告.md' })
})

test('W8 export 渲染为 Markdown 快照', () => {
  const state = {
    scopeId: 'ws:abc', status: 'active', version: 3,
    goal: '黄金回归集落地', focus: '跑测试',
    decisions: [{ text: '锚定 store 契约' }],
    nextSteps: ['合并', '发布'],
    nextMeta: [{ deadline: '2026-09-10', deliverable: 'release notes' }, null],
    artifacts: ['docs/a.md'], unresolved: ['版本策略'],
    completedSteps: [{ text: '写用例', at: '2026-09-07T00:00:00.000Z' }],
  }
  const md = renderWorkStateExport(state)
  assert.ok(md.startsWith('# WorkState 快照'))
  assert.ok(md.includes('黄金回归集落地'))
  assert.ok(md.includes('1. 合并（截止 2026-09-10）  → 交付: release notes'))
  assert.ok(md.includes('2. 发布'))
  assert.ok(md.includes('锚定 store 契约'))
  assert.ok(md.includes('docs/a.md'))
  assert.ok(md.includes('版本策略'))
  assert.ok(md.includes('写用例'))
})


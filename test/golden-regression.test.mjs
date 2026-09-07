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
import { WC_SECTION_KEY, registerWorkStateSection, scopeIdForCwd, renderWorkStateExport, renderWorkStateBrief } from '../src/index.mjs'

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

// ---- W9/W10（2026-09-07 审计修复回归）：done 同步 nextMeta / clear 全重置 ----
function mockCheckpointCtx() {
  const listeners = {}
  const registered = []
  const commands = { register: (def) => registered.push(def) }
  const services = {}
  const ctx = {
    get(name) {
      if (name === 'commands') return commands
      if (name === 'session') return { cwd: 'D:\\ws\\wc-golden' }
      if (name === 'work') return services.work
      return undefined
    },
    on(evt, cb) { (listeners[evt] ??= []).push(cb); return () => {} },
    provide(name, svc) { services[name] = svc },
    inject() {},
    effect() { return () => {} },
    logger: { info() {}, warn() {}, error() {} },
    __registered: registered,
  }
  return ctx
}

test('W9 done <n> 同步 nextMeta（防 deadline 串项，P1-1 回归）', async (t) => {
  const { apply } = await import('../src/index.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'wc-w9-'))
  const ctx = mockCheckpointCtx()
  apply(ctx, { workDir: dir })
  const cmd = ctx.__registered.find((d) => d.name === 'checkpoint')
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  await cmd.handler({ rawInput: 'next 任务一' })
  await cmd.handler({ rawInput: 'next 任务二' })
  // 给任务一补 deadline（work_state 工具路径模拟：next 后补 meta）
  const store = openWorkStore({ dir })
  const sid = scopeIdForCwd('D:\\ws\\wc-golden')
  let st = store.get({ scopeId: sid })
  st = store.save({ scopeId: sid, nextMeta: [{ deadline: '2026-09-10', deliverable: 'deliverable.md' }, null] })
  assert.equal(st.nextSteps.length, 2)
  assert.deepEqual(st.nextMeta[0], { deadline: '2026-09-10', deliverable: 'deliverable.md' })

  // done 1：任务一完成 → nextSteps=[任务二]，nextMeta 必须同步移除第 0 项
  const r = await cmd.handler({ rawInput: 'done 1' })
  assert.ok(r.kind === 'success', r.text)
  st = store.get({ scopeId: sid })
  assert.deepEqual(st.nextSteps, ['任务二'])
  assert.equal(st.nextMeta.length, 1, 'nextMeta 应与 nextSteps 同步收缩')
  assert.equal(st.nextMeta[0], null, '剩余条目的 meta 不应串位')

  // 再 next + deadline：应落在新条目（index 0），而非旧条目
  await cmd.handler({ rawInput: 'next 任务三' })
  st = store.save({ scopeId: sid, nextMeta: [{ deadline: '2026-09-20', deliverable: 'x.md' }, null] })
  assert.deepEqual(st.nextMeta[0], { deadline: '2026-09-20', deliverable: 'x.md' }, '新 meta 应落在新 next 上（不串到任务二）')
  store.close()
})

test('W10 clear 全字段重置（focus/nextMeta/completedSteps 同步清，P1-2 回归）', async (t) => {
  const { apply } = await import('../src/index.mjs')
  const dir = mkdtempSync(path.join(tmpdir(), 'wc-w10-'))
  const ctx = mockCheckpointCtx()
  apply(ctx, { workDir: dir })
  const cmd = ctx.__registered.find((d) => d.name === 'checkpoint')
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  await cmd.handler({ rawInput: 'goal 测试目标' })
  await cmd.handler({ rawInput: 'focus 当前焦点' })
  await cmd.handler({ rawInput: 'next 待办一' })
  await cmd.handler({ rawInput: 'done 1' })
  await cmd.handler({ rawInput: 'decision 一个决策' })

  const store = openWorkStore({ dir })
  const sid = scopeIdForCwd('D:\\ws\\wc-golden')
  let st = store.get({ scopeId: sid })
  assert.equal(st.focus, '当前焦点')
  assert.equal(st.completedSteps.length, 1)

  const r = await cmd.handler({ rawInput: 'clear' })
  assert.ok(r.kind === 'success', r.text)
  st = store.get({ scopeId: sid })
  assert.equal(st.goal, '')
  assert.equal(st.status, 'planned')
  assert.equal(st.focus, null, 'focus 应被清空')
  assert.equal(st.nextSteps.length, 0)
  assert.equal(st.nextMeta.length, 0, 'nextMeta 应被清空')
  assert.equal(st.completedSteps.length, 0, 'completedSteps 应被清空')
  assert.equal(st.decisions.length, 0)
  store.close()
})

// ---- W11/W12（2026-09-07 T4 M4.5）：注入摘要 deadline 渲染 + 逾期标记 ----

test('W11 next 带 nextMeta deadline → 摘要渲染 (dl 日期)；未到期无警告', () => {
  const in10d = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10)
  const out = renderWorkStateBrief({
    scopeId: 's', goal: '目标', status: 'active',
    nextSteps: ['任务一', '任务二'],
    nextMeta: [{ deadline: in10d, deliverable: '交付.md' }, null],
    decisions: [], unresolved: [],
  })
  assert.ok(out.includes('next: 任务一（dl ' + in10d + '） / 任务二'), '未到期附 (dl)，meta 越界项原样')
  assert.ok(!out.includes('⚠'), '未到期无逾期标记')
})

test('W12 deadline 已过期 → ⚠ 逾期标记；非法日期格式原样', () => {
  const past = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const out = renderWorkStateBrief({
    scopeId: 's', goal: 'g', status: 'active',
    nextSteps: ['过期任务', '格式怪任务'],
    nextMeta: [{ deadline: past }, { deadline: '不是日期' }],
    decisions: [], unresolved: [],
  })
  assert.ok(out.includes('（⚠ 逾期 ' + past + '）'), '过期附逾期标记')
  assert.ok(out.includes('格式怪任务'), '非法日期原样不炸')
  assert.ok(!out.includes('不是日期'), '非法日期不渲染')
})

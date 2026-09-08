// test/scheduler-metering.test.mjs — S1-P7（B9 v0.3）：注入调度器接线（方案 A 主动上报）。
// 契约：调度器是可选依赖——缺失/故障 fail-open，绝不阻断注入与 turn。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WC_SECTION_KEY,
  registerWorkStateSection,
  reportWorkStateUsage,
} from '../src/index.mjs'

/** mock ctx：get 返回 services + on 收集 internal/service 订阅 */
function mockCtx(services = {}, handlers = []) {
  const ctx = {
    get: (name) => services[name] ?? undefined,
    on: (event, fn) => { if (event === 'internal/service') handlers.push(fn); return () => {} },
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
  }
  return ctx
}

/** fake scheduler：收集 registerSection/recordUsage 调用 */
function fakeScheduler(overrides = {}) {
  const calls = { sections: [], usage: [] }
  return {
    calls,
    registerSection: async (input) => { calls.sections.push(input); return { ok: true, key: input.key } },
    recordUsage: async (input) => { calls.usage.push(input); return { ok: true, key: 'k', total: input.injectedChars, count: 1 } },
    ...overrides,
  }
}

test('S1-P7 registerWorkStateSection：就绪即注册（参数契约：wc.work_state / order 20 / 0=未设上限 / chars）', () => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  registerWorkStateSection(ctx)
  assert.equal(sched.calls.sections.length, 1)
  assert.deepEqual(sched.calls.sections[0], {
    key: WC_SECTION_KEY,
    plugin: 'dsh-work-continuity',
    order: 20,
    budgetChars: 0,       // 0 = 未设上限（WC 无预算概念）
    unit: 'chars',        // WC 截断全按字符
    refresh: 'per-turn',  // 每轮注入
  })
})

test('S1-P7 registerWorkStateSection：未就绪 → 订阅 internal/service，就绪事件到达后注册', () => {
  const handlers = []
  const services = {}
  const ctx = mockCtx(services, handlers)
  ctx.get = (name) => services[name] ?? undefined
  registerWorkStateSection(ctx)
  assert.equal(handlers.length, 1)
  services.injectScheduler = fakeScheduler()
  handlers[0]('injectScheduler')
  assert.equal(services.injectScheduler.calls.sections.length, 1)
  assert.equal(services.injectScheduler.calls.sections[0].key, 'wc.work_state')
})

test('S1-P7 registerWorkStateSection：scheduler 从未出现 → 静默', () => {
  const ctx = mockCtx({})
  assert.doesNotThrow(() => registerWorkStateSection(ctx))
})

test('S1-P7 reportWorkStateUsage：上报 body 实际字符', async () => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  const body = '[work-state] goal: P7 接入 | next: 提交 / 验证'
  reportWorkStateUsage(ctx, 'session-9', body)
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sched.calls.usage.length, 1)
  assert.deepEqual(sched.calls.usage[0], {
    sessionId: 'session-9',
    section: WC_SECTION_KEY,
    injectedChars: body.length,
  })
})

test('S1-P7 reportWorkStateUsage：空 sessionId → 不传（global 槽）', async () => {
  const sched = fakeScheduler()
  const ctx = mockCtx({ injectScheduler: sched })
  reportWorkStateUsage(ctx, '', '内容')
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(Object.hasOwn(sched.calls.usage[0], 'sessionId'), false)
})

test('S1-P7 reportWorkStateUsage：空 body / scheduler 缺失 / recordUsage 故障 → 全部 fail-open', async () => {
  const base = fakeScheduler()
  const sched = {
    ...base,
    recordUsage: async (input) => { base.calls.usage.push(input); throw new Error('down') },
  }
  const ctx = mockCtx({ injectScheduler: sched })
  assert.doesNotThrow(() => reportWorkStateUsage(ctx, 's', ''))
  assert.doesNotThrow(() => reportWorkStateUsage(ctx, 's', '有内容'))   // reject → .catch 吞
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(sched.calls.usage.length, 1, '只有非空 body 那次会尝试')
  const ctx2 = mockCtx({})
  assert.doesNotThrow(() => reportWorkStateUsage(ctx2, 's', '无调度器'))
})


// ── 接线守卫（2026-09-05 M5 装配教训）────────────────────────────────────────
// 此前 patch 时"已插入"守卫被函数定义行（export function registerWorkStateSection(ctx)）
// 误匹配 → apply 里从未调用 registerWorkStateSection（wc.work_state 段从未注册）且模块级
// 测试全绿。守卫 = 源码级断言：apply 调用 + 注入点上报调用必须存在。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

test('接线守卫：apply 调用 registerWorkStateSection(ctx)（段注册接线在）', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.mjs'), 'utf8')
  const lines = src.split(/\r?\n/)
  assert.ok(
    lines.some((l) => l.trim() === 'registerWorkStateSection(ctx)'),
    'apply 内必须有独立调用行（函数定义行带 export function 前缀不算）',
  )
})

test('接线守卫：pre-step 注入点存在 reportWorkStateUsage 调用（非定义行）', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.mjs'), 'utf8')
  const lines = src.split(/\r?\n/)
  const bodyIdx = lines.findIndex((l) => l.includes('const body = renderWorkStateBrief(state)'))
  assert.ok(bodyIdx >= 0, '注入点存在（renderWorkStateBrief 调用）')
  const after = lines.slice(bodyIdx, bodyIdx + 6)
  assert.ok(
    after.some((l) => l.trim() === 'reportWorkStateUsage(ctx, sessionId, body)'),
    '注入点后 6 行内必须有上报调用',
  )
})

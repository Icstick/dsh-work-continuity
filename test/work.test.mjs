// test/work.test.mjs — WorkState 存储与 checkpoint 处理测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openWorkStore } from '../src/store.mjs'
import { apply as wcApply, scopeIdForCwd } from '../src/index.mjs'

function fresh(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-work-'))
  const store = openWorkStore({ dir })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store
}

test('保存并读取 WorkState', (t) => {
  const store = fresh(t)
  const saved = store.save({
    scopeId: 'user-global', projectId: 'acp',
    goal: '实现 Context Composer', status: 'active',
    decisions: [{ text: '先做 budget', evidenceIds: [] }],
    nextSteps: ['测试', '合并'],
  })
  assert.equal(saved.goal, '实现 Context Composer')
  assert.equal(saved.status, 'active')
  assert.equal(saved.version, 1)
  assert.equal(saved.decisions.length, 1)

  const got = store.get({ scopeId: 'user-global', projectId: 'acp' })
  assert.equal(got.goal, '实现 Context Composer')
  assert.deepEqual(got.nextSteps, ['测试', '合并'])
})

test('upsert 递增 version', (t) => {
  const store = fresh(t)
  store.save({ scopeId: 's', goal: 'v1' })
  const v2 = store.save({ scopeId: 's', goal: 'v2' })
  assert.equal(v2.version, 2)
  assert.equal(v2.goal, 'v2')
})

test('不同 scope 隔离', (t) => {
  const store = fresh(t)
  store.save({ scopeId: 'ws1', goal: '项目A' })
  store.save({ scopeId: 'ws2', goal: '项目B' })
  assert.equal(store.get({ scopeId: 'ws1' }).goal, '项目A')
  assert.equal(store.get({ scopeId: 'ws2' }).goal, '项目B')
  assert.equal(store.get({ scopeId: 'ws3' }), null)
})

test('局部 save 保留已有字段', (t) => {
  const store = fresh(t)
  store.save({ scopeId: 's', goal: 'g', decisions: [{ text: 'd1' }] })
  const updated = store.save({ scopeId: 's', status: 'blocked' })
  assert.equal(updated.goal, 'g')
  assert.equal(updated.status, 'blocked')
  assert.equal(updated.decisions.length, 1)
})

test('状态枚举校验（非法 status 拒绝）', (t) => {
  const store = fresh(t)
  assert.throws(() => store.save({ scopeId: 's', status: 'invalid' }), /status must be one of/)
})

// ---- /checkpoint 命令注册（commands 服务就绪时序） ----

function mockCtx({ commandsAtStart }) {
  const listeners = {}
  const registered = []
  const ctx = {
    get(name) { return name === 'commands' ? commandsAtStart : undefined },
    on(evt, cb) { (listeners[evt] ??= []).push(cb); return () => {} },
    provide() {},
    inject() {}, // settings 可选服务：测试 mock 无 settings → no-op
    effect() { return () => {} },
    __emit(evt, ...args) { for (const cb of listeners[evt] ?? []) cb(...args) },
    __registered: registered,
  }
  return ctx
}

test('apply 时 commands 已就绪 → 立即注册', async (t) => {
  const apply = wcApply
  const registered = []
  const ctx = mockCtx({ commandsAtStart: { register: (def) => registered.push(def) } })
  apply(ctx, { workDir: mkdtempSync(path.join(tmpdir(), 'acp-wc-')) })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'checkpoint')
  assert.equal(typeof registered[0].handler, 'function')
})

test('apply 时 commands 未就绪 → internal/service 事件后注册（2026-08-27 正式实例教训）', async (t) => {
  const { apply } = await import('../src/index.mjs')
  const registered = []
  const ctx = mockCtx({ commandsAtStart: undefined })
  apply(ctx, { workDir: mkdtempSync(path.join(tmpdir(), 'acp-wc-')) })
  assert.equal(registered.length, 0) // 未就绪：不注册、不抛错
  // 服务随后就绪（订阅 internal/service）
  const commands = { register: (def) => registered.push(def) }
  const origGet = ctx.get
  ctx.get = (name) => (name === 'commands' ? commands : origGet(name))
  ctx.__emit('internal/service', 'commands')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'checkpoint')
})
test('handleCheckpoint：ctx 无 session 服务时不抛 without inject（2026-08-27 正式实例教训）', async (t) => {
  const { apply } = await import('../src/index.mjs')
  const registered = []
  const ctx = mockCtx({ commandsAtStart: { register: (def) => registered.push(def) } })
  apply(ctx, { workDir: mkdtempSync(path.join(tmpdir(), 'acp-wc-')) })
  const result = await registered[0].handler({ rawInput: 'goal 测试目标' })
  assert.equal(result.kind, 'success')
  assert.ok(result.text.includes('goal set'))
})


// ---- P1-5：自动捕获（goal/change / todo/write 权威事件，2026-09-02）----

function mockAutoCtx({ dir }) {
  const listeners = {}
  const cleanups = []
  const services = {}
  const ctx = {
    get(name) {
      if (name === 'session') return { cwd: 'D:\\ws\\proj-a' }
      if (name === 'work') return services.work
      return undefined
    },
    on(evt, cb) { (listeners[evt] ??= []).push(cb); return () => {} },
    provide(name, svc) { services[name] = svc },
    inject() {},
    effect(fn) { try { const c = fn(); if (typeof c === 'function') cleanups.push(c) } catch {} },
    __emit(evt, ...args) { for (const cb of listeners[evt] ?? []) cb(...args) },
    logger: { info() {}, warn() {}, error() {} },
    __listeners: listeners,
    __cleanups: cleanups,
    __services: services,
  }
  return ctx
}


async function freshAuto(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acp-wc-auto-'))
  const ctx = mockAutoCtx({ dir })
  wcApply(ctx, { workDir: dir })
  t.after(() => {
    try { for (const c of ctx.__cleanups) c() } catch {}
    rmSync(dir, { recursive: true, force: true })
  })
  return { ctx, work: ctx.__services.work, scopeId: scopeIdForCwd('D:\\ws\\proj-a') }
}

test('P1-5 goal/change create → 建档 goal/status', async (t) => {
  const { ctx, work, scopeId } = await freshAuto(t)
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'goal/change',
    data: { kind: 'goal/change', operation: 'create', goal: { objective: '完成 M6 daemon', phase: 'active' } },
  })
  const state = work.get(scopeId)
  assert.ok(state, 'state 应建档')
  assert.equal(state.goal, '完成 M6 daemon')
  assert.equal(state.status, 'active')
})

test('P1-5 goal/change complete/pause → status 映射', async (t) => {
  const { ctx, work, scopeId } = await freshAuto(t)
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'goal/change', data: { operation: 'create', goal: { objective: 'g1', phase: 'active' } },
  })
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'goal/change', data: { operation: 'complete', goal: { objective: 'g1', phase: 'complete' } },
  })
  assert.equal(work.get(scopeId).status, 'done')
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'goal/change', data: { operation: 'pause', goal: { objective: 'g1', phase: 'paused' } },
  })
  assert.equal(work.get(scopeId).status, 'paused')
})

test('P1-5 goal/change clear → goal 清空', async (t) => {
  const { ctx, work, scopeId } = await freshAuto(t)
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'goal/change', data: { operation: 'create', goal: { objective: 'g1', phase: 'active' } },
  })
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'goal/change', data: { operation: 'clear', cleared: { id: 'x', revision: 2 } },
  })
  const st = work.get(scopeId)
  assert.equal(st.goal, '')
  assert.equal(st.status, 'planned')
})

test('P1-5 todo/write（≥2 未完成）且无 state → 自动建档', async (t) => {
  const { ctx, work, scopeId } = await freshAuto(t)
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'todo/write',
    data: { todos: [
      { content: '修 consolidation', status: 'in_progress' },
      { content: '补测试', status: 'pending' },
      { content: '提交', status: 'pending' },
    ] },
  })
  const st = work.get(scopeId)
  assert.ok(st, 'todo/write 应建档')
  assert.equal(st.status, 'active')
  assert.equal(st.focus, '修 consolidation')
  assert.ok(st.nextSteps.includes('修 consolidation'))
  assert.ok(st.nextSteps.includes('补测试'))
})

test('P1-5 todo/write 已有 state 或 <2 未完成 → 不覆盖/不建', async (t) => {
  const { ctx, work, scopeId } = await freshAuto(t)
  // 已有 state（goal 事件建档）
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'goal/change', data: { operation: 'create', goal: { objective: '真目标', phase: 'active' } },
  })
  ctx.__emit('session/event', { cwd: 'D:\\ws\\proj-a' }, {
    type: 'todo/write', data: { todos: [{ content: '任务A', status: 'pending' }, { content: '任务B', status: 'pending' }] },
  })
  let st = work.get(scopeId)
  assert.equal(st.goal, '真目标') // goal 不被 todo 覆盖
  assert.equal(st.nextSteps.length, 0) // nextSteps 不被 todo 填充
  // 单任务不建：换 scope（不同 cwd）
  const dir2 = mkdtempSync(path.join(tmpdir(), 'acp-wc-auto2-'))
    const ctx2 = mockAutoCtx({ dir: dir2 })
  ctx2.get = (name) => name === 'session' ? { cwd: 'D:\\ws\\proj-b' } : (name === 'work' ? ctx2.__services.work : undefined)
  wcApply(ctx2, { workDir: dir2 })
  t.after(() => { try { for (const c of ctx2.__cleanups) c() } catch {} rmSync(dir2, { recursive: true, force: true }) })
  ctx2.__emit('session/event', { cwd: 'D:\\ws\\proj-b' }, {
    type: 'todo/write', data: { todos: [{ content: '单一任务', status: 'in_progress' }] },
  })
  assert.equal(ctx2.__services.work.get(scopeIdForCwd('D:\\ws\\proj-b')), null)
})


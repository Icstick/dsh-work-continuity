// test/work.test.mjs — WorkState 存储与 checkpoint 处理测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openWorkStore } from '../src/store.mjs'

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
    effect() { return () => {} },
    __emit(evt, arg) { for (const cb of listeners[evt] ?? []) cb(arg) },
    __registered: registered,
  }
  return ctx
}

test('apply 时 commands 已就绪 → 立即注册', async (t) => {
  const { apply } = await import('../src/index.mjs')
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

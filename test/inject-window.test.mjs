// test/inject-window.test.mjs — 2026-10-11 注入窗口修正 + cwd 属性路径修正的回归测试
//
// 两个 bug 都在 A 机 2026-10-11 实测复现：
//   ① decisions / unresolved 是只追加的日志，注入却 slice(0, N) 取最旧的 N 条
//      → A 机 decisions 223 条时，index 2..222 共 221 条永不进入上下文，
//        而注入进去的 index 1 早在 index 23 就被订正推翻过。
//   ② cwd 读在 session.cwd 上，实际在 session.header.cwd 上 → ws:<hash> 分支成死代码。
// 本文件锁住这两条，防止回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderWorkStateBrief, cwdOfSession, cwdFromCtx, scopeIdForCwd } from '../src/index.mjs'

// 零填充：避免 'decision-10'.includes('decision-1') 这种子串碰撞把断言搞成假通过/假失败
const dec = (n) => Array.from({ length: n }, (_, i) => ({ text: 'decision-' + String(i + 1).padStart(2, '0'), evidenceIds: [] }))

// ---------- ① 注入窗口：日志类取尾部 ----------

test('decisions 取最新 N 条，不取最旧 N 条（223 条场景的缩小版）', () => {
  const st = { goal: 'g', status: 'active', decisions: dec(10), nextSteps: [], unresolved: [] }
  const out = renderWorkStateBrief(st)
  assert.ok(out.includes('decision-10'), '应包含最后一条')
  assert.ok(out.includes('decision-09'), '应包含倒数第二条')
  assert.ok(!out.includes('decision-01'), '不应包含最旧那条')
  assert.ok(!out.includes('decision-02'), '不应包含次旧那条')
})

test('unresolved 取最新 N 条，不取最旧 N 条', () => {
  const st = { goal: 'g', status: 'active', decisions: [], nextSteps: [], unresolved: ['u1', 'u2', 'u3', 'u4', 'u5'] }
  const out = renderWorkStateBrief(st)
  assert.ok(out.includes('u5') && out.includes('u4'))
  assert.ok(!out.includes('u1') && !out.includes('u2'))
})

test('next_steps 仍取最前 N 条 —— 它是队列（next 追加 / done 移除），队首才是「下一个该做的」', () => {
  const st = { goal: 'g', status: 'active', decisions: [], unresolved: [], nextSteps: ['n1', 'n2', 'n3', 'n4', 'n5'] }
  const out = renderWorkStateBrief(st)
  assert.ok(out.includes('n1') && out.includes('n2') && out.includes('n3'))
  assert.ok(!out.includes('n4') && !out.includes('n5'))
})

test('数组不足窗口大小时不越界、不重复', () => {
  const st = { goal: 'g', status: 'active', decisions: dec(1), nextSteps: ['only'], unresolved: ['solo'] }
  const out = renderWorkStateBrief(st)
  assert.ok(out.includes('decision-01'))
  assert.equal(out.match(/decision-01/g).length, 1)
  assert.ok(out.includes('only') && out.includes('solo'))
})

test('空数组不产生 decided / open 行', () => {
  const out = renderWorkStateBrief({ goal: 'g', status: 'active', decisions: [], nextSteps: [], unresolved: [] })
  assert.ok(!out.includes('decided:'))
  assert.ok(!out.includes('open:'))
})

// ---------- ② cwd 属性路径 ----------

test('cwdOfSession 读 header.cwd（正确路径）', () => {
  assert.equal(cwdOfSession({ id: 's1', header: { cwd: 'D:\\ws\\proj-a' } }), 'D:\\ws\\proj-a')
})

test('cwdOfSession 对「cwd 挂在顶层」的旧错误形状返回 undefined —— 不再静默读到顶层的假值', () => {
  assert.equal(cwdOfSession({ id: 's1', cwd: 'D:\\ws\\wrong' }), undefined)
})

test('cwdOfSession 对空/异常输入返回 undefined 而不抛', () => {
  assert.equal(cwdOfSession(undefined), undefined)
  assert.equal(cwdOfSession(null), undefined)
  assert.equal(cwdOfSession({}), undefined)
  assert.equal(cwdOfSession({ header: {} }), undefined)
  assert.equal(cwdOfSession({ header: { cwd: 42 } }), undefined)
})

test('header 与顶层同时存在时，以 header 为准', () => {
  assert.equal(cwdOfSession({ cwd: 'X', header: { cwd: 'Y' } }), 'Y')
})

test('cwdFromCtx 经 ctx.get("session") 取 header.cwd', () => {
  const ctx = { get: (k) => (k === 'session' ? { header: { cwd: 'D:\\ws\\from-ctx' } } : undefined) }
  assert.equal(cwdFromCtx(ctx), 'D:\\ws\\from-ctx')
})

test('cwdFromCtx：settings 服务缺失 / get 抛错 时返回 undefined，不炸', () => {
  assert.equal(cwdFromCtx({}), undefined)
  assert.equal(cwdFromCtx({ get: () => { throw new Error('boom') } }), undefined)
  assert.equal(cwdFromCtx(undefined), undefined)
})

test('scopeIdForCwd：有 cwd → ws:<hash>；无 cwd → user-global（行为未变）', () => {
  const a = scopeIdForCwd('D:\\DSH_workspace')
  assert.match(a, /^ws:[0-9a-f]{12}$/)
  assert.equal(a, 'ws:cc3f97d9a2f5', 'D:\\DSH_workspace 的 scope id 应与 A 机库里那条僵尸行一致')
  assert.equal(scopeIdForCwd(undefined), 'user-global')
  assert.equal(scopeIdForCwd(''), 'user-global')
  assert.equal(scopeIdForCwd(123), 'user-global')
})

test('端到端：修好路径后，带 header.cwd 的会话不会再落 user-global 桶', () => {
  const session = { id: 's', header: { cwd: 'D:\\ws\\proj-a' } }
  const sid = scopeIdForCwd(cwdOfSession(session))
  assert.notEqual(sid, 'user-global')
  assert.equal(sid, scopeIdForCwd('D:\\ws\\proj-a'))
})

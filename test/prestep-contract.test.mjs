// test/prestep-contract.test.mjs — agent/pre-step 护栏（事件纪律 P1，2026-10-02）
// ---------------------------------------------------------------------------
// 为什么要有这个文件：agent/pre-step 是 cordis **waterfall**——
//   · handler 不调 next() 即否决（下游客全不跑）；
//   · 但调了 next() 之后**必须**返回合法决策（{kind:'reject'} | {kind:'enter', messages}），
//     返回 undefined 会破坏整条链（上游拿不到决策）。
//   本仓 handler（src/index.mjs:523-549）有 4 条 early-return
//   （非首步且无重锚 / 下游非 enter / 无 state 或 done / 摘要为空）
//   + 1 条「压缩后重锚」注入分支（返回**新的**决策对象）+ 1 条 fail-open catch，
//   此前没有一条测试钉住「每条 return 路径都返回合法决策」。
//   本文件补上：遍历每条 return 路径，断言三件——
//     ① 返回值是合法 PreStepDecision（**绝不是 undefined**）；
//     ② next 被调用过（不得跳过下游）；
//     ③ handler 不抛（fail-open）。
//
// 契约原文（本仓）：src/index.mjs:506-509（fail-open：异常返回原决策/空决策）
// waterfall 语义（上游）：@deepseek-ai/cordis src/events.ts:234-243（不调 next 即否决）
//
// 只驱动 apply() 的接线层，**不改产品代码**；WorkState 全落 tmp 目录，不碰真实 work.db。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply as wcApply, scopeIdForCwd } from '../src/index.mjs'

/** 最小 fake ctx（照 test/work.test.mjs 的 mockAutoCtx 写法） */
function mockAutoCtx() {
  const listeners = {}
  const cleanups = []
  const services = {}
  const ctx = {
    get(name) {
      if (name === 'session') return { header: { cwd: 'D:\\ws\\proj-guard' } }
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

const CWD = 'D:\\ws\\proj-guard'

/** 起一个跑在 tmp 里的 WC；返回 pre-step handler、ctx 与 scopeId */
function boot(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wc-prestep-'))
  const ctx = mockAutoCtx()
  wcApply(ctx, { workDir: dir })
  t.after(() => {
    try { for (const c of ctx.__cleanups) c() } catch {}
    rmSync(dir, { recursive: true, force: true })
  })
  const pre = (ctx.__listeners['agent/pre-step'] ?? [])[0]
  assert.equal(typeof pre, 'function', 'apply 必须注册 agent/pre-step handler')
  return { pre, ctx, scopeId: scopeIdForCwd(CWD) }
}

/**
 * 合法 PreStepDecision 判定（本仓契约 = 平台 waterfall 契约）：
 * {kind:'reject'} | {kind:'enter', messages:[]}；undefined / null / 裸对象一律不算。
 */
function isPreStepDecision(v) {
  if (!v || typeof v !== 'object') return false
  if (v.kind === 'reject') return true
  return v.kind === 'enter' && Array.isArray(v.messages)
}

const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const SESSION = { id: 'sess-guard', header: { cwd: CWD } }
const stepPayload = (step) => ({ step, agent: { session: SESSION } })
const baseDecision = () => ({ kind: 'enter', messages: [userMsg('随便聊聊今天的事')] })

/** 驱动 handler：stub next 返回 downstream（或抛 throwsError），记录调用次数 */
async function drive(pre, payload, { downstream, throwsError } = {}) {
  let nextCalls = 0
  const next = async () => {
    nextCalls += 1
    if (throwsError) throw throwsError
    return downstream
  }
  const result = await pre(payload, next)
  return { result, nextCalls, sameRef: result === downstream }
}

// ---- 护栏自检：判定函数本身不吃非法值（否则下面的断言会静默失效） ----

test('护栏自检：isPreStepDecision 不吃 undefined / null / 裸对象', () => {
  assert.equal(isPreStepDecision(undefined), false)
  assert.equal(isPreStepDecision(null), false)
  assert.equal(isPreStepDecision({}), false)
  assert.equal(isPreStepDecision({ kind: 'enter' }), false)          // 缺 messages
  assert.equal(isPreStepDecision({ kind: 'enter', messages: [] }), true)
  assert.equal(isPreStepDecision({ kind: 'reject' }), true)
})

// ---- 分支 1：非首步且无重锚（src/index.mjs:529） ----

test('分支 非首步（无重锚）：透传下游决策、必调 next、返回合法决策', async (t) => {
  const { pre } = boot(t)
  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(2), { downstream: decision })

  assert.equal(nextCalls, 1, 'next 必须被调用（不得跳过下游）')
  assert.ok(isPreStepDecision(result), '返回值必须是合法 PreStepDecision，实际: ' + JSON.stringify(result))
  assert.equal(sameRef, true, '非首步原样透传（不自造决策对象）')
})

// ---- 分支 2：下游不是 enter（src/index.mjs:530） ----

test('分支 下游 reject：原样透传 reject、必调 next、不注入', async (t) => {
  const { pre } = boot(t)
  const decision = { kind: 'reject' }
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(result.kind, 'reject', '下游否决不得被我方翻成 enter')
  assert.equal(sameRef, true)
})

// ---- 分支 3：无 state 或 status==='done'（src/index.mjs:535） ----

test('分支 无 state：首步原样透传', async (t) => {
  const { pre } = boot(t)
  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, true)
})

test('分支 status=done：不再注入（完成态不打扰）', async (t) => {
  const { pre, ctx, scopeId } = boot(t)
  ctx.__services.work.save({ scopeId, goal: '已收口的活', status: 'done' })
  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, true, 'done 态走 early-return')
  assert.equal(result.messages.length, 1)
})

// ---- 分支 4：摘要为空（src/index.mjs:537） ----

test('分支 摘要为空：有 state 但 renderWorkStateBrief 返回空串时原样透传', async (t) => {
  const { pre, ctx, scopeId } = boot(t)
  ctx.__services.work.save({ scopeId, status: 'active' }) // 只有 status：goal/focus/next/decisions/unresolved 全空
  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, true)
  assert.equal(result.messages.length, 1, '空摘要不得产生空注入消息')
})

// ---- 分支 5：正常注入（src/index.mjs:542） ----

test('分支 正常注入：活跃 state → 追加一条 source-labelled 消息（新决策对象）', async (t) => {
  const { pre, ctx, scopeId } = boot(t)
  ctx.__services.work.save({ scopeId, goal: '重构工具箱', status: 'active', nextSteps: ['迁移 v3', '部署'] })

  const decision = baseDecision()
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, false, '注入路径必须返回**新的**决策对象')
  assert.equal(result.kind, 'enter')
  assert.equal(result.messages.length, decision.messages.length + 1, '下游消息前段原样保留，注入追加在尾部')
  assert.equal(result.messages[0], decision.messages[0], '不得改动下游消息本身')
  const injected = result.messages[result.messages.length - 1]
  assert.equal(injected.source.kind, 'plugin:dsh-work-continuity')
  assert.equal(injected.role, 'user')
  assert.match(injected.content[0].text, /\[work-state\]/)
  assert.ok(injected.content[0].text.includes('重构工具箱'))
})

// ---- 分支 6：压缩后重锚（step!==1 也注入一次，src/index.mjs:528/542） ----

test('分支 压缩后重锚：非首步也补注一次（新决策对象），随后清标记不再重复', async (t) => {
  const { pre, ctx, scopeId } = boot(t)
  ctx.__services.work.save({ scopeId, goal: '压缩后别丢状态', status: 'active' })
  const mk = () => baseDecision()

  // step 1：正常注入
  let r = await drive(pre, stepPayload(1), { downstream: mk() })
  assert.equal(r.sameRef, false, 'step1 注入')
  assert.equal(r.result.messages.length, 2)

  // step 3：无压缩 → 透传
  r = await drive(pre, stepPayload(3), { downstream: mk() })
  assert.equal(r.sameRef, true, '无压缩时非首步不注入')

  // 发生压缩
  const sessListeners = ctx.__listeners['session/event'] ?? []
  assert.ok(sessListeners.length >= 1, 'session/event 监听已注册')
  for (const cb of sessListeners) cb({ id: SESSION.id }, { type: 'compaction/summary', data: {} })

  // step 4：重锚补注（走的是 step!==1 的早返回之前的重锚分支）
  r = await drive(pre, stepPayload(4), { downstream: mk() })
  assert.equal(r.nextCalls, 1)
  assert.ok(isPreStepDecision(r.result))
  assert.equal(r.sameRef, false, '重锚分支必须返回新的决策对象')
  assert.equal(r.result.messages.length, 2)
  assert.ok(r.result.messages[1].content[0].text.includes('压缩后别丢状态'))

  // step 5：标记已清 → 透传
  r = await drive(pre, stepPayload(5), { downstream: mk() })
  assert.equal(r.sameRef, true, '重锚只补一次')
})

// ---- fail-open：next() 抛错（src/index.mjs:543-548） ----

test('fail-open：next() 抛错时返回合法空决策，不外抛', async (t) => {
  const { pre } = boot(t)
  const { result, nextCalls } = await drive(pre, stepPayload(1), { throwsError: new Error('downstream boom') })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result), 'fail-open 也必须给合法决策，实际: ' + JSON.stringify(result))
  assert.equal(result.kind, 'enter')
  assert.deepEqual(result.messages, [])
})

// ---- fail-open：决策已拿到、插件内部抛错（src/index.mjs:546） ----

test('fail-open：拿到下游决策后内部抛错 → 原样返回下游决策（不吞不造）', async (t) => {
  const { pre } = boot(t)
  const decision = baseDecision()
  // cwd 取值即抛：发生在 decision 赋值之后、注入之前
  const boomSession = { id: 'sess-guard-boom', header: { get cwd() { throw new Error('cwd boom') } } }
  const { result, nextCalls, sameRef } = await drive(pre, { step: 1, agent: { session: boomSession } }, { downstream: decision })

  assert.equal(nextCalls, 1)
  assert.ok(isPreStepDecision(result))
  assert.equal(sameRef, true, '已有决策时照原样返回，不落成空决策')
})

// ---- 现状记录（挂账，见 P1 报告）：下游违规返回 undefined 时我方透传 ----

test('现状记录：下游 next() 返回 undefined 时我方透传 undefined（不自造决策）', async (t) => {
  const { pre } = boot(t)
  const { result, nextCalls, sameRef } = await drive(pre, stepPayload(1), { downstream: undefined })

  assert.equal(nextCalls, 1)
  // 本条**不是**断言“护栏正确”，而是把现状钉住：
  // 我方不校验下游返回值，undefined 会原样透传（链路破坏由违规的下游负责）。
  // 若将来在链路某处加规范化，这条会红 —— 那时同步更新 P1 纪律。
  assert.equal(result, undefined)
  assert.equal(sameRef, true)
  assert.equal(isPreStepDecision(result), false, '现状：此路径不产生合法决策（已挂账）')
})

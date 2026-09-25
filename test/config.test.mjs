import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, mergeSettingsIntoConfig, unwrapVolatileConfig } from '../src/index.mjs'

// P3-3 修复（2026-09-07 审计）：原文件第二个 test 意外嵌套进第一个且未 await——
// node:test 隐式容忍掩盖了结构错误，未来有 flaky 风险。重写为两个独立顶层 test。

test('Config：默认值校验（debug false；workDir 缺省不报错）', async () => {
  // 0.1.7：Config 字段带 .volatile()（设置页要）—— schema 产出的是 cosmokit 响应式引用，
  // 读值前必须解包；插件 apply 里走同一个 unwrapVolatileConfig。
  const r = await Config['~standard'].validate({})
  const plainEmpty = unwrapVolatileConfig(r.value)
  assert.equal(plainEmpty.debug, false)
  assert.equal(plainEmpty.workDir, undefined)
  const withBoth = await Config['~standard'].validate({ workDir: 'D:\\w', debug: true })
  const plain = unwrapVolatileConfig(withBoth.value)
  assert.equal(plain.workDir, 'D:\\w')
  assert.equal(plain.debug, true)
})

test('unwrapVolatileConfig：解包 volatile 引用，普通值/数组/嵌套对象原样', async () => {
  const r = await Config['~standard'].validate({ workDir: 'D:\\w', debug: true })
  const plain = unwrapVolatileConfig(r.value)
  assert.equal(typeof plain.workDir, 'string')
  assert.equal(typeof plain.debug, 'boolean')
  assert.deepEqual(unwrapVolatileConfig({ a: 1, b: 'x' }), { a: 1, b: 'x' })
  assert.deepEqual(unwrapVolatileConfig([1, 2, 3]), [1, 2, 3])
  assert.equal(unwrapVolatileConfig(null), null)
  assert.equal(unwrapVolatileConfig('plain'), 'plain')
})

test('mergeSettingsIntoConfig：settings 覆盖 workDir，缺失时保留 Config', () => {
  const ctx = { get: () => ({ get: () => ({ workDir: 'D:\\new-work' }) }) }
  const merged = mergeSettingsIntoConfig(ctx, { workDir: 'D:\\old-work', debug: false })
  assert.equal(merged.workDir, 'D:\\new-work')
  assert.equal(merged.debug, false)
  const bare = mergeSettingsIntoConfig({ get: () => undefined }, { workDir: 'D:\\old-work' })
  assert.equal(bare.workDir, 'D:\\old-work')
})

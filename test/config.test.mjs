import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, mergeSettingsIntoConfig } from '../src/index.mjs'

// P3-3 修复（2026-09-07 审计）：原文件第二个 test 意外嵌套进第一个且未 await——
// node:test 隐式容忍掩盖了结构错误，未来有 flaky 风险。重写为两个独立顶层 test。

test('Config：默认值校验（debug false；workDir 缺省不报错）', async () => {
  const r = await Config['~standard'].validate({})
  assert.deepEqual(r.value, { debug: false })
  const withBoth = await Config['~standard'].validate({ workDir: 'D:\\w', debug: true })
  assert.equal(withBoth.value.workDir, 'D:\\w')
  assert.equal(withBoth.value.debug, true)
})

test('mergeSettingsIntoConfig：settings 覆盖 workDir，缺失时保留 Config', () => {
  const ctx = { get: () => ({ get: () => ({ workDir: 'D:\\new-work' }) }) }
  const merged = mergeSettingsIntoConfig(ctx, { workDir: 'D:\\old-work', debug: false })
  assert.equal(merged.workDir, 'D:\\new-work')
  assert.equal(merged.debug, false)
  const bare = mergeSettingsIntoConfig({ get: () => undefined }, { workDir: 'D:\\old-work' })
  assert.equal(bare.workDir, 'D:\\old-work')
})

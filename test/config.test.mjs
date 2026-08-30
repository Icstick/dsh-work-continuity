import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../src/index.mjs'

test('plugin config validates defaults through Standard Schema', async () => {
  const result = await Config['~standard'].validate({})

  assert.deepEqual(result, {
    value: {
      debug: false,
    },
  })
test('mergeSettingsIntoConfig：settings 覆盖 workDir，缺失时保留 Config', async () => {
  const { mergeSettingsIntoConfig } = await import('../src/index.mjs')
  const ctx = { get: () => ({ get: () => ({ workDir: 'D:\\new-work' }) }) }
  const merged = mergeSettingsIntoConfig(ctx, { workDir: 'D:\\old-work', debug: false })
  assert.equal(merged.workDir, 'D:\\new-work')
  assert.equal(merged.debug, false)
  const bare = mergeSettingsIntoConfig({ get: () => undefined }, { workDir: 'D:\\old-work' })
  assert.equal(bare.workDir, 'D:\\old-work')
})

})

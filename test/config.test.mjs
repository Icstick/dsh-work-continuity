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
})

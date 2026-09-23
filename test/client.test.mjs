import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** 载入构建产物，返回注册对象 + 最小 react 替身（0.1.6/0.1.7 双路径测试共用）。 */
function loadBundle() {
  let registration
  runInNewContext(bundle, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.ok(registration)
  const plugin = registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useState: (initial) => [initial, () => {}],
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    }
  })
  return plugin
}

/** 0.1.6 侧槽位/设置（settingsScope）服务替身；0.1.7 侧不存在这些服务。 */
async function provideSlotsOnly(ctx, onRegister = () => {}) {
  await ctx.plugin({
    apply(provider) {
      provider.provide('slots', {
        inject(_name, register) { return register() },
        register(_meta, value) { onRegister(value); return () => {} },
      })
    },
  })
}

async function provideLegacyServices(ctx, onRegister = () => {}) {
  await ctx.plugin({
    apply(provider) {
      provider.provide('slots', {
        inject(_name, register) { return register() },
        register(_meta, value) { onRegister(value); return () => {} },
      })
      provider.provide('settingsScope', {
        bind(input) {
          return {
            namespace: input?.namespace,
            subscribe() { return () => {} },
            getSnapshot() { return { value: {}, user: {}, writable: true } },
            set() {},
            unset() {},
          }
        },
      })
    },
  })
}

test('静态 inject 只剩 slots：0.1.6 / 0.1.7 都能激活条目（0.1.7 不再 pending）', () => {
  const plugin = loadBundle()
  assert.deepEqual([...plugin.inject], ['slots'])
})

test('0.1.7：settingsScope 不存在 → apply 不抛、条目激活、不注册设置卡片（跳过自绘卡片）', async (t) => {
  const plugin = loadBundle()
  const registrations = []
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await provideSlotsOnly(ctx, (component) => registrations.push(component))
  await ctx.plugin(plugin)
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.deepEqual(registrations, [], '0.1.7 上不得注册 settings.section（平台生成设置页）')
})

test('0.1.6：settingsScope 存在 → 仍注册「工作连续性」section，行为与本改动前一致', async (t) => {
  const plugin = loadBundle()
  const registrations = []
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await provideLegacyServices(ctx, (component) => registrations.push(component))
  await ctx.plugin(plugin)
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.equal(registrations.length, 1)
  assert.equal(typeof registrations[0], 'function', '注册的可渲染组件')
})

test('fail-open：settingsScope.bind 抛错也不外抛（条目仍激活）', async (t) => {
  const plugin = loadBundle()
  const registrations = []
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin({
    apply(provider) {
      provider.provide('slots', {
        inject(_name, register) { return register() },
        register(_meta, value) { registrations.push(value); return () => {} },
      })
      provider.provide('settingsScope', {
        bind() { throw new Error('boom') },
      })
    },
  })
  await ctx.plugin(plugin)
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.deepEqual(registrations, [])
})

test('settings section explains that blank fields fall back to plugin defaults', async (t) => {
  const plugin = loadBundle()

  let component
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await provideLegacyServices(ctx, (value) => { component = value })
  await ctx.plugin(plugin)
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.equal(typeof component, 'function')

  // 空 namespace（settings.yaml 无该键）下走一遍渲染，断言留空语义的提示确实出现在面板上
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    for (const child of node.children ?? []) walk(child)
  }
  walk(component())
  assert.ok(
    texts.some((text) => text.includes('未填写的项由插件采用设计默认')),
    'blank fields must be explained as falling back to plugin defaults',
  )
})

// client/index.js — dsh-work-continuity 设置页卡片（bundle-ready CJS 风格源码）。
//
// 构建：node scripts/build-client.mjs → lib/client.js。
// 运行依赖（DSH client module table 提供，dsh.client.inject 声明）：
//   react（预加载 external）、@deepseek-ai/dsh-client-ui-slots（ctx.slots）、
//   @deepseek-ai/dsh-client-ui-settings（ctx.settingsScope）。
// 自包含：字段渲染 + staged 草稿 + 保存自实现；文案写死中文（v1 不做 i18n）。

const { h, useState, useSyncExternalStore } = require('react')

/** 设置页 namespace（与 host 侧 SETTINGS_NAMESPACE 一致） */
const NS = 'work-continuity'

const TITLE = '工作连续性（Work Continuity）'
const DESC = '跨会话工作状态 · /checkpoint'

const FIELDS = [
  { name: 'workDir', label: '工作状态目录', hint: 'WorkState 持久化目录（重启生效）', type: 'text' },
  { name: 'debug', label: '调试日志', type: 'toggle' },
]

function draftOf(value) {
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (value === null || value === undefined) return ''
  return String(value)
}

function parseDraft(field, text) {
  const trimmed = String(text ?? '').trim()
  if (field.type === 'toggle') return trimmed === 'true'
  if (trimmed === '') return null
  return trimmed
}

const rowStyle = {
  display: 'flex', flexDirection: 'column', gap: '4px',
  padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)',
}
const labelStyle = { fontSize: '13px', color: 'var(--dsw-alias-label-primary, #1f2937)' }
const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' }
const inputStyle = {
  fontSize: '13px', padding: '4px 8px', borderRadius: '6px',
  border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
  background: 'var(--dsw-alias-field-bg, #fff)', color: 'var(--dsw-alias-label-primary, #111827)',
}
const badgeStyle = {
  fontSize: '11px', color: '#b45309', background: '#fef3c7',
  borderRadius: '999px', padding: '1px 8px', marginLeft: '8px',
}
const resetBtnStyle = {
  fontSize: '12px', color: '#b45309', background: 'none', border: 'none',
  cursor: 'pointer', textDecoration: 'underline', padding: 0,
}

function FieldControl(p) {
  const { field, value, draft, overridden, disabled, onDraft, onReset } = p
  const text = draft !== undefined ? draft : draftOf(value)
  const common = {
    id: 'wc-field-' + field.name,
    disabled,
    style: inputStyle,
    value: field.type === 'toggle' ? (text === 'true') : text,
  }
  let control
  if (field.type === 'toggle') {
    control = h('input', {
      ...common, type: 'checkbox', checked: text === 'true',
      onChange: (e) => onDraft(String(e.target.checked)),
    })
  } else {
    control = h('input', {
      ...common, type: 'text',
      onChange: (e) => onDraft(e.target.value),
    })
  }
  return h('div', { style: rowStyle },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
      h('label', { htmlFor: common.id, style: labelStyle }, field.label),
      overridden ? h('span', { style: badgeStyle }, '已覆盖') : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, control,
      overridden ? h('button', { type: 'button', style: resetBtnStyle, disabled, onClick: onReset }, '重置') : null),
    field.hint ? h('div', { style: hintStyle }, field.hint) : null)
}

function makeCard(scope) {
  return function Card() {
    const snapshot = useSyncExternalStore(
      (cb) => scope.subscribe(cb),
      () => scope.getSnapshot(),
    )
    const value = snapshot?.value && typeof snapshot.value === 'object' ? snapshot.value : {}
    const userLayer = snapshot?.user && typeof snapshot.user === 'object' ? snapshot.user : {}
    const writable = snapshot?.writable === true
    const [drafts, setDrafts] = useState(null)
    const [open, setOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)

    const dirty = drafts !== null
    const invalid = dirty && FIELDS.some((f) =>
      drafts[f.name] !== undefined && parseDraft(f, drafts[f.name]) === undefined)

    async function save() {
      if (!dirty || invalid || saving) return
      setSaving(true); setFailed(false)
      try {
        const writes = []
        for (const field of FIELDS) {
          if (!(field.name in drafts)) continue
          const parsed = parseDraft(field, drafts[field.name])
          if (parsed === undefined) continue
          if (parsed === null) writes.push(scope.unset(field.name))
          else writes.push(scope.set(field.name, parsed))
        }
        await Promise.all(writes)
        setDrafts(null)
      } catch {
        setFailed(true)
      } finally {
        setSaving(false)
      }
    }

    function discard() { setDrafts(null); setFailed(false) }
    function onDraft(name, text) {
      setFailed(false)
      setDrafts((prev) => { const next = { ...(prev ?? {}) }; next[name] = text; return next })
    }
    function onReset(name) {
      setFailed(false)
      setDrafts((prev) => { const next = { ...(prev ?? {}) }; next[name] = ''; return next })
    }

    const headerStyle = {
      display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
      background: 'none', border: 'none', cursor: 'pointer', padding: '12px 4px',
      textAlign: 'left', font: 'inherit',
    }
    return h('li', { style: { listStyle: 'none' } },
      h('button', {
        type: 'button', style: headerStyle, 'aria-expanded': open,
        'aria-label': (open ? '收起设置: ' : '展开设置: ') + TITLE,
        onClick: () => setOpen(!open),
      },
        h('span', { style: { fontWeight: 600, fontSize: '14px', color: 'var(--dsw-alias-label-primary, #111827)' } }, TITLE),
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, DESC),
        dirty ? h('span', { style: badgeStyle }, '未保存') : null,
        h('span', { style: { marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none' } }, '▾')),
      open ? h('div', { style: { padding: '0 4px 12px' } },
        !writable ? h('p', { role: 'status', style: hintStyle }, '当前文档不可写（只读模式）') : null,
        FIELDS.map((field) => h(FieldControl, {
          key: field.name, field,
          value: value[field.name],
          draft: drafts ? drafts[field.name] : undefined,
          overridden: userLayer[field.name] !== undefined,
          disabled: !writable || saving,
          onDraft: (text) => onDraft(field.name, text),
          onReset: () => onReset(field.name),
        })),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', paddingTop: '12px' } },
          failed ? h('p', { role: 'status', style: { ...hintStyle, color: '#b91c1c', marginRight: 'auto', alignSelf: 'center' } }, '保存失败，请重试') : null,
          h('button', {
            type: 'button', disabled: !dirty || saving,
            style: { ...inputStyle, background: 'none', color: '#6b7280', cursor: 'pointer' },
            onClick: discard,
          }, '放弃'),
          h('button', {
            type: 'button', disabled: !dirty || invalid || saving,
            style: {
              ...inputStyle, cursor: 'pointer', fontWeight: 600,
              background: 'var(--dsw-alias-accent, #2563eb)', color: '#fff', borderColor: 'transparent',
            },
            onClick: save,
          }, saving ? '保存中…' : '保存')))
        : null)
  }
}

/** client 插件入口：注册设置卡片（keyed by namespace）。 */
function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: NS },
    makeCard(scope),
  ))
}

// build.mjs 模板注入 exports.apply
exports.apply = apply

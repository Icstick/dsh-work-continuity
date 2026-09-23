window.__ModuleLoader__.load({
	id: "dsh-work-continuity",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// client/index.js — dsh-work-continuity 设置页（bundle-ready CJS 风格源码）。
		//
		// 构建：node scripts/build-client.mjs → lib/client.js。
		// dsh.client.inject 声明包关系；Cordis 服务依赖由下方 exports.inject 声明并控制激活。
		// react 由平台预加载，ui-slots 提供 ctx.slots。
		// 自包含：字段渲染 + staged 草稿 + 保存自实现。
		// 注册为设置面板顶层 section（settings.section「工作连续性」，与费用/Vision Router 同层）。
		// 文案写死中文（v1 不做 i18n）。
		//
		// --- dsh 0.1.6 / 0.1.7 双兼容（2026-09-23）---
		// 0.1.6：ui-settings 提供 ctx.settingsScope（bind → get/subscribe/getSnapshot/set/unset），本页即在设置面板
		//        渲染「工作连续性」卡片（顶层 section），保存写入 settings.yaml。
		// 0.1.7：settingsScope 已删除（本页原先的静态 inject ['slots','settingsScope'] 会一直 pending，
		//        顶栏报 "waiting for service: settingsScope"）。设置页改由平台生成：host 入口的 Config schema
		//        投影成 form（无 .volatile() 字段的入口不产生 form），设置区由 settings.plugin-manager 页托管，
		//        页面标题即 profile entry id（本插件 = cordis.patch.yml 的 insert id「work-continuity」）。
		//        实测（D:\dsh-0.1.7-alpha1\packages\settings\settings\src\index.ts:304-331 + schema.ts:37-47）
		//        Config 无 volatile 字段 → volatileForm() 返回 undefined → describe() 里该 entry 为空；
		//        configForms.get('work-continuity').getSnapshot() 只会停在 { status:'unavailable', value:undefined }。
		//        即 0.1.7 上没有任何设置值可读、也没有自绘卡片的立足点：本页只做「读设置/渲染设置卡片」，
		//        不驱动其他 UI 行为 → 在 0.1.7 上**整体跳过卡片**，0.1.6 行为保持不变。
		//        静态 inject 只保留 slots（0.1.6/0.1.7 都提供），settingsScope 改为命令式
		//        ctx.inject(['settingsScope'], …)：服务不存在时回调永不触发，条目正常激活（fail-open）。
		//        注：「设置 → 插件」的 form 只认 .volatile() 字段，host 侧是否加 volatile 属 host 侧改动，不在本文件内。
		
		// React 无顶层 h（那是 preact 的 API）——createElement 起别名 h 供组件使用
		const { createElement: h, useState, useSyncExternalStore } = require('react')
		
		/** 设置页 namespace（与 host 侧 SETTINGS_NAMESPACE 一致） */
		const NS = 'work-continuity'
		
		const TITLE = '工作连续性（Work Continuity）'
		const DESC = '跨会话工作状态 · /checkpoint'
		
		/** 空值语义提示（2026-09-17）：本页是覆盖层，留空不代表没配置 */
		const EMPTY_HINT = '未填写的项由插件采用设计默认；填写后覆盖配置文件，重启生效。'
		
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
		  background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary, #111827)',
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
		
		/**
		 * 设置 section 面板组件（自包含：闭包捕获 bound scope）。
		 * @param {object} scope - ctx.settingsScope.bind({namespace}) 结果（0.1.6 路径）
		 */
		function makeSection(scope) {
		  return function Section() {
		    const snapshot = useSyncExternalStore(
		      (cb) => scope.subscribe(cb),
		      () => scope.getSnapshot(),
		    )
		    const value = snapshot?.value && typeof snapshot.value === 'object' ? snapshot.value : {}
		    const userLayer = snapshot?.user && typeof snapshot.user === 'object' ? snapshot.user : {}
		    const writable = snapshot?.writable === true
		    const [drafts, setDrafts] = useState(null)
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
		      setDrafts((prev) => { const next = { ...prev }; next[name] = text; return next })
		    }
		    function onReset(name) {
		      setFailed(false)
		      setDrafts((prev) => { const next = { ...prev }; next[name] = ''; return next })
		    }
		
		    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
		      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', padding: '2px 2px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2, #e5e7eb)' } },
		        h('span', { style: { fontWeight: 600, fontSize: '15px', color: 'var(--dsw-alias-label-primary, #111827)' } }, TITLE),
		        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, DESC),
		        dirty ? h('span', { style: badgeStyle }, '未保存') : null),
		      h('p', { style: { ...hintStyle, padding: '0 2px 8px' } }, EMPTY_HINT),
		      h('div', { style: { padding: '2px 2px 8px' } },
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
		    )
		  }
		}
		
		/** 客户端诊断日志（0.1.7 无 logger 时退化为 console；再不行就静默——绝不抛）。 */
		function warn(message) {
		  try {
		    if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message)
		  } catch { /* 日志本身绝不外抛 */ }
		}
		
		/** 注册「工作连续性」顶层 section（两条兼容路径共用的唯一注册点）。 */
		function registerSection(ctx, scope) {
		  ctx.slots.inject('settings.section', () => ctx.slots.register(
		    { name: 'settings.section', id: 'work-continuity', order: 170, label: '工作连续性' },
		    makeSection(scope),
		  ))
		}
		
		/**
		 * client 插件入口。
		 *
		 * 静态 inject 只有 slots → 0.1.6 / 0.1.7 都能激活条目（0.1.7 不再 pending）。
		 * 设置 source 用命令式注入按版本取：
		 *   0.1.6 命中 settingsScope（bind → 自绘卡片，行为与本改动前逐字节一致）；
		 *   0.1.7 没有 settingsScope，也没有可读的 configForms form（见文件头实测结论）→ 不注册卡片，跳过。
		 * 全程 fail-open：解析不到就 warn 后返回，绝不 throw（条目激活不受影响）。
		 */
		function apply(ctx) {
		  try {
		    ctx.inject(['settingsScope'], (scopeCtx) => {
		      try {
		        const scope = scopeCtx.settingsScope.bind({ namespace: NS })
		        if (!scope || typeof scope.getSnapshot !== 'function' || typeof scope.subscribe !== 'function') {
		          warn('[work-continuity] settingsScope 形状不认识，跳过设置卡片（fail-open）')
		          return
		        }
		        registerSection(scopeCtx, scope)
		      } catch (error) {
		        warn('[work-continuity] 设置卡片注册失败，忽略：' + String(error))
		      }
		    })
		  } catch (error) {
		    warn('[work-continuity] settingsScope 命令式注入不可用，忽略：' + String(error))
		  }
		}
		
		exports.inject = ['slots']
		exports.apply = apply;
		return module.exports;
	}
});

# dsh-work-continuity

DeepSeek Harness (dsh) 的 **Work Continuity** 插件——跨会话的工作状态显式持久化，和通用记忆分开管理。

> 设计铁律（与 ACP 一致）：**记忆不负责替你把活干完。**
> 目标、决策、下一步这些工作状态，不该混在记忆里被遗忘或被乱注入——它们是独立管理、随时可查的。

## 为什么需要它

和 agent 干活的人应该都熟这个场景：昨天干到一半，今天打开新会话，agent 一脸茫然——"我们昨天聊到哪了？"你只好翻聊天记录，重新交代一遍背景。

Work Continuity 把工作状态变成**一条命令的事**：目标、决策、下一步，你说一句就记下来；下次会话一句话就全部想起。

## 一个简单的例子

昨天你加班到半夜，临走前对 agent 说：

> 记住，下一步是把测试跑通。

它记下了。今天早上你打开电脑，敲一句：

> /checkpoint show

目标、当时做的决策、下一步该干什么，全部列出来。你不用回忆，它也不用道歉。

## 命令

| 命令 | 说明 | 示例 |
|---|---|---|
| `/checkpoint goal <内容>` | 设置当前目标 | `/checkpoint goal 完成 M3 开发` |
| `/checkpoint decision <内容>` | 记录一个决策 | `/checkpoint decision 用 MIT 许可` |
| `/checkpoint next <内容>` | 添加下一步行动 | `/checkpoint next 合流组A` |
| `/checkpoint artifact <路径>` | 记录产物路径 | `/checkpoint artifact D:/out/report.pdf` |
| `/checkpoint unresolved <内容>` | 记录没解决的问题 | `/checkpoint unresolved 审批面板没显示` |
| `/checkpoint status <状态>` | 更新进度状态 | `/checkpoint status active`（planned/active/blocked/paused/done） |
| `/checkpoint focus <内容>` | 设置当前焦点 | `/checkpoint focus 修回归` |
| `/checkpoint show` | 查看当前工作状态 | `/checkpoint show` |
| `/checkpoint clear` | 清空 | `/checkpoint clear` |

## 设计取舍

MVP 只做**显式命令持久化**——你说记什么，它记什么，全程人可以核对。不做每轮自动总结：自动总结省事，但常常记错重点，而且你不知道它偷偷记了什么。

## 安装

三步（和 dsh-adaptive-context 一样）：

**1. profile package.json**：

```json
{
  "dependencies": {
    "dsh-work-continuity": "link:D:/path/to/dsh-work-continuity"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-work-continuity"]
    }
  }
}
```

**2. profile cordis.patch.yml**：

```yaml
- id: work-continuity
  name: dsh-work-continuity
  config:
    workDir: C:\path\to\work-state   # 必须显式写
```

**3. 安装并重启**：

```bash
cd <profile 目录>
pnpm install
# 重启 dsh
```

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workDir` | string | **必填** | 工作状态数据目录（work.db 所在）。必须显式指定，DSH_HOME 环境变量不可靠 |
| `debug` | boolean | false | 调试日志 |

## 数据位置

- `workDir/work.db`（SQLite 单文件）——全部工作状态
- **数据是你的**：卸载不删；装回来即恢复

## 卸载

1. 从 package.json dependencies 移除 dsh-work-continuity
2. 从 dsh.profile.bundles 移除包名
3. pnpm install 后重启

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| /checkpoint 命令不存在 | commands 服务随 bundle 加载顺序可能晚于插件就绪——插件会等它出现再注册；还不行就检查 bundle 挂载 |
| 数据落在意外位置 | workDir 没显式配置（默认回退 DSH_HOME，环境变量不可靠）——务必显式配置 |

## 开发

```bash
node test/work.test.mjs
```

## License 与致谢

MIT License。参考项目致谢见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。

## 设置页配置卡片（v0.1.1+）

- 位置：DSH Web **设置 → 插件 → 插件配置**（`work-continuity` 卡片）
- 机制：host 侧注册 settings namespace（`work-continuity`），client bundle（`lib/client.js`，
  由 `node scripts/build-client.mjs` 生成）注册设置卡片；保存写入 settings.yaml
- 生效语义：**保存后重启生效**（apply 时 settings 值覆盖 cordis Config）
- 字段：workDir（重启生效）/ debug

# dsh-work-continuity

DeepSeek Harness (dsh) 的 **Work Continuity** 插件——跨会话工作状态显式持久化，与通用记忆解耦。

> 设计铁律（与 ACP 对齐）：**Memory does not own work continuity.**
> 工作状态（目标/决策/下一步）不该混在记忆里被遗忘或误注入——它是独立的、显式管理的、可随时查看的。

## 这是什么

每次会话结束时丢失"我刚才在做什么"是 agent 工作的常态痛点。Work Continuity 把工作状态变成**显式命令持久化的第一公民**：

- `/checkpoint goal 完成 ACP 正式环境验证` → 目标被记录
- 下次会话 `/checkpoint show` → 立刻知道要继续什么

MVP 为**显式命令持久化**（human-checkable），不做每 turn LLM 自动总结——你要记什么，自己说了算。

## 命令

| 命令 | 说明 | 示例 |
|---|---|---|
| `/checkpoint goal <text>` | 设置当前目标 | `/checkpoint goal 完成 M3 开发` |
| `/checkpoint decision <text>` | 记录一个决策 | `/checkpoint decision 用 MIT 许可` |
| `/checkpoint next <text>` | 添加下一步行动 | `/checkpoint next 合流组A` |
| `/checkpoint artifact <path>` | 记录产物路径 | `/checkpoint artifact D:/out/report.pdf` |
| `/checkpoint unresolved <text>` | 记录未解决问题 | `/checkpoint unresolved 审批面板未显示` |
| `/checkpoint status <状态>` | 更新进度状态 | `/checkpoint status active`（planned/active/blocked/paused/done） |
| `/checkpoint focus <text>` | 设置当前焦点 | `/checkpoint focus 修复回归` |
| `/checkpoint show` | 查看当前 WorkState | `/checkpoint show` |
| `/checkpoint clear` | 清空 | `/checkpoint clear` |

## 安装

三步（与 dsh-adaptive-context 相同）：

**1. profile `package.json`**：

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

**2. profile `cordis.patch.yml`**：

```yaml
- id: work-continuity
  name: dsh-work-continuity
  config:
    workDir: C:\path\to\work-state   # 必须显式
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
| `workDir` | string | **必填** | WorkState 数据目录（`work.db` 所在）。必须显式指定，不要依赖 DSH_HOME 环境变量 |
| `debug` | boolean | false | 调试日志 |

## 数据位置

- `workDir/work.db`（SQLite 单文件）——WorkState 全部数据
- **数据是你的资产**：卸载不删；重装即恢复

## 卸载

1. 从 `package.json` dependencies 移除 `dsh-work-continuity`
2. 从 `dsh.profile.bundles` 移除包名
3. `pnpm install` 后重启

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| `/checkpoint` 命令不存在 | commands 服务随 bundle 加载顺序可能晚于插件就绪——插件会自动等待其就绪后注册；若仍缺失，确认 bundle 挂载正确 |
| 数据落到了意外位置 | `workDir` 未显式配置（默认回退 DSH_HOME，环境变量不可靠）——务必显式配置 |

## 开发

```bash
node test/work.test.mjs
```

## License & 致谢

MIT License。参考项目致谢见 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md)。

# dsh 集成

本仓库提供一个 dsh Agent Preset 与一个 Cordis 工具插件：

- Preset：`presets/pg-dba/`（persona、工具行、六项技能）
- 插件：`packages/dsh-plugin/`（`@backup-agent/dsh-plugin`）
- CLI 单文件包：`dist/bkagent.mjs`（`pnpm build:cli` 生成）

插件是薄适配层：只负责参数校验、argv 构建、审批与结果呈现；执行与策略全部在 `bkagent` 控制面内。

## 安装

```sh
scripts/install-dsh.sh web
```

脚本执行：

1. `pnpm build:cli` 生成 `dist/bkagent.mjs`；
2. 复制 preset 到 `${DSH_HOME:-~/.dsh}/.agent-presets/pg-dba`；
3. `dsh plugin --profile web add link:<repo>/packages/dsh-plugin`。

重启 dsh 后，在会话创建时选择「PostgreSQL 备份恢复」预设。

## 工具

| 工具 | 作用 | 风险 |
|---|---|---|
| `pg_inspect` | 实例版本、角色、WAL、归档、数据库清单 | 只读 |
| `pg_backup` | 逻辑/物理备份，可写控制库 | 只读 |
| `pg_restore` | 逻辑恢复；建库或 `--clean` 走审批 | 破坏性 |
| `pg_verify` | 恢复到临时库并比对行数 | 可逆 |
| `pg_catalog` | 备份产物清单 | 只读 |
| `pg_report` | 运行报表 | 只读 |

`pg_restore` 在 `createDatabase` 或 `clean` 为真时调用 `ctx.approval.request()`；没有发起主体或审批服务不可用时**失败关闭**。

## 技能

`presets/pg-dba/skills/`：

- `pg-backup`：逻辑/物理/pgBackRest/WAL-G 选型
- `pg-restore`：目标库、属主、扩展、`--clean` 风险
- `pg-pitr`：可恢复窗口、WAL 连续性、promote 断言
- `pg-verify`：V0–V3 校验与 VRP
- `pg-troubleshoot`：按故障目录签名定位
- `engine-extend`：新增引擎/provider 的清单

## 使用示例

```
> 检查 10.0.0.5:5432 的实例状态，并给出一份每日全量 + 保留 30 天的方案
> 对 app 库做一次 custom 格式备份到 /backups/app.dump，然后校验它
> 把 /backups/app.dump 恢复到新库 app_restore_20261112，并报告行数比对结果
```

## 本地校验（不依赖模型）

```sh
pnpm build:cli
node --input-type=module -e "
import * as plugin from './packages/dsh-plugin/index.js'
const run = plugin.createRunner()
const info = await plugin.createHandlers(run).inspect({ dsn: 'postgres://user:pass@127.0.0.1:5432/postgres' })
console.log(info.serverVersionNum)
"
```

## 约束

- 不在插件内执行 SQL 或拼接 Shell 字符串。
- Preset 与技能随目录复制，不修改 dsh 自带的 preset。
- 插件只依赖 `@deepseek-ai/dsh-tools`；dsh 运行时提供 `ctx.tools` 与 `ctx.approval`。

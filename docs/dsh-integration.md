# dsh 集成

本仓库提供一个 dsh Agent Preset 与一个 Cordis 工具插件：

- Preset：`presets/pg-dba/`（persona、工具行、六项技能）
- 插件：`packages/dsh-plugin/`（`@backup-agent/dsh-plugin`）
- CLI 单文件包：`dist/bkagent.mjs`（`pnpm build:cli` 生成）

插件是薄适配层：只负责参数校验、argv 构建、审批与结果呈现；执行与策略全部在 `bkagent` 控制面内。

## 安装

前置：dsh 0.2.x（本文按 `0.2.2-rc.4` 验证，`dsh --version` 可查当前版本）。

```sh
scripts/install-dsh.sh web
```

脚本执行：

1. `pnpm build:cli` 生成 `dist/bkagent.mjs`，`pnpm build:knowledge` 生成 `dist/bkagent-knowledge.mjs`；
2. `var/knowledge.sqlite` 不存在时执行 `pnpm --filter @backup-agent/knowledge index`；
3. `dsh plugin --profile web add link:<repo>/packages/dsh-plugin`。

插件包声明了 `dsh.bundle`，`add` 会把它写进 profile 的 `dsh.profile.bundles`，并按 `cordis.patch.yml` 插入一条 `@deepseek-ai/dsh-agent-preset` 行：`pg-dba` 预设的 persona、工具行与六项技能都在这一行内，不再复制到 `$DSH_HOME/.agent-presets/`。

验证：

```sh
dsh --profile web --dump-config | grep -A2 preset-pg-dba
dsh --profile web --no-open        # 设置 → Agent 预设 → 自定义：PostgreSQL 备份恢复
```

`--dump-config` 出现 `preset-pg-dba` 说明补丁层已生效；设置页出现「自定义 / PostgreSQL 备份恢复」且没有「加载失败」，说明预设内每一行（含 `@backup-agent/dsh-plugin`）都已激活。

### 从 0.1.x 升级

- `$DSH_HOME/.agent-presets/<id>/` 在 0.2.x 不再被读取；预设只能来自 bundle patch 里的 `@deepseek-ai/dsh-agent-preset` 行。
- 只执行 `dsh plugin add` 而不声明 `dsh.bundle` 的包，只会成为普通依赖，不会产生任何配置层，工具也不会出现。
- persona 行在 0.2.x 要求 `prefix` 字段（0.1.x 的 `text` 不再被接受）；`{{…}}` 模板变量必须已注册，否则该预设显示「加载失败」并在设置页给出具体行与字段。

## 调用时序

工具调用、审批与知识检索的时序见 [architecture.md](architecture.md#3-dsh-调用时序)。

## 工具

| 工具 | 作用 | 风险 |
|---|---|---|
| `pg_inspect` | 实例版本、角色、WAL、归档、数据库清单 | 只读 |
| `pg_backup` | 逻辑/物理备份，可写控制库 | 只读 |
| `pg_restore` | 逻辑恢复；所有输入均按可能含破坏性 SQL 处理并走审批 | 破坏性 |
| `pg_verify` | 恢复到临时库并比对行数、schema、amcheck | 可逆 |
| `pg_pitr` | 按 time/LSN/name/xid 恢复到目标数据目录；先经 `ctx.approval` | 破坏性 |
| `pg_catalog` | 备份产物清单 | 只读 |
| `pg_report` | 运行报表 | 只读 |
| `kb_search` | 在 SAG2 证据库中检索原文段落（source#ordinal + 标题路径） | 只读 |

每次 `pg_restore` 调用都会先调用 `ctx.approval.request()`；即使没有 `createDatabase` 或 `clean`，转储输入也可能含有 `DROP` 等破坏性 SQL。没有发起主体或审批服务不可用时**失败关闭**。CLI 还会要求精确登记 Asset、`--yes`，并对生产目标执行双人复核。

工具调用携带的取消信号会透传到后端进程：工具被取消时 `spawn` 以 `signal` 中止，不会留下无人等待的备份进程。`kb_search` 的 query 放在 `--` 之后，因此以 `-` 开头的问题（例如「为什么 `--type=time` 不生效」）不会被当成选项。

pgBackRest / WAL-G 与运维类命令（`pgbackrest-*` / `walg-*` / `retain` / `metrics` / `storage-*`）尚未暴露为工具，`pg-pitr` 之外的运维技能仍只能经 `bash` 调用 CLI，这是 P5 的已知缺口。

## 技能

`presets/pg-dba/skills/`：

- `pg-backup`：逻辑/物理/pgBackRest/WAL-G 选型
- `pg-restore`：目标库、属主、扩展、恢复授权与 `--clean` 风险
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

## 工具注册表与 MCP 入口

工具只定义一次：`packages/dsh-plugin/tools.js` 的 `TOOL_DEFINITIONS`（name、description、JSON Schema、`buildArgv`、`requiresApproval`）。两个入口都从它派生，禁止分叉定义（ADR-008）：

- dsh 插件：`index.js` 的 `apply()` 注册同名工具，参数 DSL 由共享 JSON Schema 转换而来。
- MCP stdio 服务：`node packages/dsh-plugin/mcp.js`（`bin`：`bkagent-mcp`），换行分隔的 JSON-RPC 2.0，支持 `initialize` / `ping` / `tools/list` / `tools/call`；stdout 只有协议响应。

**MCP 下的破坏性工具一律失败关闭**：MCP 没有 dsh 的审批通道，`pg_restore` / `pg_pitr` 返回 `isError: true` 并提示改用 preset 或 CLI，不会启动后端进程。

```sh
BKAGENT_CLI=$PWD/dist/bkagent.mjs node packages/dsh-plugin/mcp.js
# → {"jsonrpc":"2.0","id":1,"method":"initialize",...}
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
- `kb_search` 依赖 `dist/bkagent-knowledge.mjs` 与 `var/knowledge.sqlite`；`install-dsh.sh` 在索引缺失时会自动运行 `pnpm --filter @backup-agent/knowledge index`，也可手动重建。
- 插件只依赖 `@deepseek-ai/dsh-tools`；dsh 运行时提供 `ctx.tools` 与 `ctx.approval`。
- 该依赖目前固定在 `dependencies` 的 `0.1.2-rc.1`，因此插件目录内会存在一份 `dsh-tools` 副本。`defineTool` 与 `ctx.tools.register` 在 0.2.2 未变（仅新增 `deferLoading`、`projectContent`），插件可正常加载；dsh 官方推荐把需要共享实例的 dsh 包写成 `peerDependencies` + `devDependencies`，这一调整尚未进行。

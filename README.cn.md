> 中文翻译，随 [`README.md`](README.md) 更新。两者冲突时以英文版为准。

# backup-agent

PostgreSQL 备份、校验与恢复的确定性控制面，外层是面向智能体的工具面。

运维人员或智能体给出意图，核心将意图转换为经过校验的 `Plan`（由 argv-only 步骤组成的 Step DAG），经可插拔的 `Executor`（`local` / `ssh` / `kubectl`）执行，并把每次状态迁移以 `Ticket`、`Plan`、`Attempt`、`Artifact`、`Asset` 记录在 SQLite 控制库。确定性核心是这些状态的唯一写入者；智能体层（dsh 插件、preset 技能、CLI）只做意图解析、argv 构造、审批编排与结果呈现，不承载业务语义与安全策略。

它不是调度器，也不是 `pg_dump` 的 shell 封装。

**从这里开始：[bkagent 使用教程](docs/tutorial.html)**（图文版，完整闭环实操；Markdown 源文件见 [`docs/tutorial.md`](docs/tutorial.md)）。

- 设计基线：`../docs/plan-v1.1.md`（未纳入 Git；v1.0 在同一个目录存档）。
- 架构与执行流程：[`docs/architecture.md`](docs/architecture.md)。
- 使用手册（命令地图、场景实操、排障）：[`docs/usage.md`](docs/usage.md)。

## 范围

当前范围为**单机本地控制面**：一台机器上的一个控制库，每条命令驱动一个 PostgreSQL 目标，目标可以位于本机，也可以经 `ssh` / `kubectl` 传输到达。调度交由 cron 或 systemd 模板；多主机集群编排不在范围内。

## 能力

| 能力 | 入口 | 说明 |
|---|---|---|
| 逻辑备份与恢复 | `backup --format custom\|plain`、`restore` | `pg_dump` / `psql`；恢复一律按破坏性操作处理 |
| 恢复校验 | `verify` | 临时库行数、列/约束/索引 schema 比对、`amcheck`；产出 V2 证据 |
| 物理备份 | `backup --mode physical` | `pg_basebackup`；格式支持时执行 `pg_verifybackup` |
| 时间点恢复 | `pitr` | 恢复配置、实例启动、promote 断言、失败清理图 |
| pgBackRest / WAL-G | `pgbackrest-*`、`walg-*` | 只做编排；仓库始终归 provider 所有 |
| 保留与台账 | `retain`、`catalog`、`asset-list`、`asset-rpo`、`trace` | 按 target 计算 GFS 可达性；`retain --apply` 只写 tombstone |
| 报表与指标 | `report`、`metrics`、`capacity` | `metrics` 输出 §12 的序列，另有产物与错误计数器 |
| 告警 | `watchdog` | 对账后评估 P1–P4 告警阶梯；webhook 或 SMTP |
| 只读面板 | `dashboard --out\|--serve` | 自包含 HTML；serve 模式只绑定 `127.0.0.1` |
| 智能体面 | dsh 插件、`pg-dba` preset、`bkagent-mcp` | 一份工具注册表同时供 dsh 插件与 MCP 服务使用 |
| 闭环 | `goal`、`memory` | 目标、步骤拆解、封闭集修复与确定性记忆落控制库；破坏性步骤需人工审批，智能体无法自行放行 |
| 文档检索 | `@backup-agent/knowledge` | SAG2 证据检索，服务运维问答；不参与 Plan 生成 |

## 环境要求

- Node.js >= 22.5（`node:sqlite`；运行时的 `ExperimentalWarning: SQLite` 属预期）。
- pnpm 11.24（由 `packageManager` 固定）。
- 目标实例为 PostgreSQL 14–17，`psql` / `pg_dump` 可用。
- 可选，仅对应链路需要：`pgbackrest`、`wal-g`、`pg_verifybackup`（最后一个位于 `/usr/lib/postgresql/<ver>/bin`，默认不在 `PATH` 上）。

## 安装与首次运行

```sh
pnpm install
pnpm build:cli                       # dist/bkagent.mjs + dist/migrations

export BKAGENT_DSN='postgres://backup@127.0.0.1:5432/app'

node dist/bkagent.mjs inspect --format text
node dist/bkagent.mjs asset-set --db .bkagent/control.db \
  --target 127.0.0.1:5432/app --engine postgres --environment production \
  --owner dba --criticality high --data-classification internal \
  --rpo-minutes 1440 --rto-minutes 240
node dist/bkagent.mjs backup  --database app --out /var/backups/app.dump --format custom
node dist/bkagent.mjs verify  --input /var/backups/app.dump --database app
node dist/bkagent.mjs catalog
```

`asset-set` 只对恢复（破坏性操作）强制，但提前登记资产是 `watchdog`、`asset-rpo` 与双人复核可用的前提。`--target` 不是自由文本：必须是 `<host>:<port>/<database>`，并与计划计算出的 `targetId` 完全一致，否则恢复准入检查会以「资产未登记」拒绝执行。

开发态用 `pnpm bkagent <command>` 经 `tsx` 直接运行同一份 CLI，参数完全一致。

## 命令面

按任务分组；完整参考、准入条件与实操示例见 [`docs/usage.md`](docs/usage.md)：

- 探测与登记：`inspect`、`providers`、`asset-set`、`asset-list`、`asset-rpo`。
- 备份：`backup`、`pgbackrest-backup`、`walg-backup`。
- 恢复：`restore`、`pgbackrest-restore`、`walg-restore`、`pitr`。
- 校验：`verify`。
- 台账：`catalog`、`retain`、`storage-purge`、`storage-gc`、`artifact-add`、`artifact-upload`、`trace`。
- 观测：`report`、`metrics`、`capacity`、`watchdog`、`dashboard`、`notify-test`。
- 派发与审批：`outbox-dispatch`、`approve`、`approvals`。
- 直接执行 provider 命令：`exec -- <argv>`。
- 多步任务：`goal`、`memory`。

退出码：`0` 成功、`1` 执行失败、`2` 用法错误、`3` 连接失败、`4` plan 或 probe 失败。

## 安全模型

- `Executor` 仅接受 argv（`spawn(argv[])`，`shell: false`）；Plan 校验拒绝 argv 中的 shell 元字符，代码中不存在拼接 shell 字符串的路径。
- 每个 step 必须声明 `idempotencyKey`，执行前重新求值前置条件。计划指纹不匹配时，目标身份变化即终止，仅配置变化则生成新 Plan 并把旧 Plan 标为 `superseded`。
- 破坏性计划仅来自 `DESTRUCTIVE_PLAN_COMMANDS`；计划声明的风险低于 `destructive` 会被拒绝执行（`risk-understated`），拒绝事件写入审计 Outbox。
- 所有逻辑恢复按破坏性操作处理：需要 `--yes`、已登记的 Asset，生产目标另需两条绑定操作 digest 的审批。双人复核按操作系统身份去重，同一用户无法用两个标签满足。
- 凭据只经子进程环境变量或 principal 注册表的 `dsnEnv` 传递，不进入 argv、日志、Plan 或指标标签。
- 外部副作用与状态迁移在同一事务内写入 Outbox：至少一次投递，接收端按 `outbox_id` 去重。
- 租约带单调递增的 fencing token，过期写入被拒绝；启动对账把过期的 `running` Attempt 标为 `stalled`。
- 能力协商失败关闭：未声明的能力明确报错，不静默降级；工具版本以探测结果为准，不信任配置声明。
- provider 仓库归 provider：保留只能走 `pgbackrest expire` / `wal-g delete retain`；仅自管 storage 允许直接删除对象。

## 代码结构

```
packages/
  core/                 @backup-agent/core（零运行时依赖）
    src/domain/         标识、风险、能力、资产、主体、模型策略、Plan、状态机、
                        能力文法（action）、目标/步骤状态机（goal）、封闭修复集（remediation）
    src/ports/          Executor / Repository / Engine / Provider / Storage / Clock
    src/plan/           校验、指纹、重基
    src/executor/       local / ssh / kubectl 执行器、POSIX 引号、错误分类
    src/runner/         谓词求值、Step DAG 执行（含 cleanup 图）、重试、检查点
    src/security/       破坏性授权、four-eyes、资产降级、principal 注册表
    src/ops/            保留、报表、指标、容量、告警、通知、artifact 摘要与 GC、
                        目标拆解与调度（goal-plan）、确定性记忆检索（memory）
    src/storage/        fs / nfs / s3（SigV4，无 SDK）
    src/persistence/    SQLite 控制库、Outbox 派发、租约、对账、运行生命周期
    src/testkit/        FakeExecutor、FixedClock
  engine-postgres/      @backup-agent/engine-postgres
    src/probe.ts        实例探测
    src/descriptor.ts   引擎描述符（版本矩阵 14–17）
    src/providers.ts    ProviderAdapter 注册表与能力协商
    src/logical.ts      pg_dump / pg_restore 计划构建
    src/physical.ts     pg_basebackup 与 PITR 计划构建
    src/pitr-window.ts  PITR 可恢复窗口预检
    src/pgbackrest.ts   pgBackRest 编排
    src/walg.ts         WAL-G 编排
    src/verify.ts       恢复校验与行数/schema 比对
  dsh-plugin/           @backup-agent/dsh-plugin（Cordis 插件 + tools.js 共享注册表 + mcp.js）
  knowledge/            @backup-agent/knowledge（SAG2 证据检索与评测）
  cli/                  @backup-agent/cli（bkagent）
```

依赖方向：`cli` 与 `dsh-plugin` 依赖 `core`；`core` 无运行时依赖，这条约束不得打破。

## 开发

```sh
pnpm install
pnpm test                        # vitest run，覆盖 packages/**/test/**/*.test.{ts,js}
pnpm -r --parallel typecheck
pnpm build:cli                   # dist/bkagent.mjs + dist/migrations
pnpm build:knowledge             # dist/bkagent-knowledge.mjs
pnpm verify:skills               # 校验 presets/pg-dba/skills/MANIFEST.json 哈希
```

集成用例需要本地 Docker 上的 PostgreSQL：16 在 `55416`、17 在 `55417`，DSN 默认 `postgres://postgres:verify_pw@127.0.0.1:55416/postgres`（可用 `BK_TEST_DSN` 覆盖）。实例不可达时用例调用 `context.skip`，文件仍计入 passed——确认是否真的执行要加 `--reporter=verbose`。S3 只有注入 `fetch` 的契约级单测；本地 MinIO（`59000-59001`）用于手工验证。

单文件或单用例：

```sh
pnpm exec vitest run packages/engine-postgres/test/logical.integration.test.ts
pnpm exec vitest run packages/core/test/plan/validate.test.ts -t 'rejects'
```

知识库（SAG2 证据检索）：

```sh
pnpm --filter @backup-agent/knowledge index   # 重建 var/knowledge.sqlite
pnpm --filter @backup-agent/knowledge ask "为什么归档失败后 PITR 窗口会缩短"
pnpm --filter @backup-agent/knowledge eval
pnpm --filter @backup-agent/knowledge stats
```

MCP 入口：`node packages/dsh-plugin/mcp.js`（`bin` 名 `bkagent-mcp`，默认调用 `dist/bkagent.mjs`，可用 `BKAGENT_CLI` 覆盖）。

## 文档

| 主题 | 文件 |
|---|---|
| 使用手册：命令地图、场景实操、准入条件、排障（含截图） | [`docs/usage.md`](docs/usage.md) |
| 架构、执行/存储/通知、授权检查、Outbox | [`docs/architecture.md`](docs/architecture.md) |
| §11 引擎/provider 契约与四个 provider | [`docs/provider-contract.md`](docs/provider-contract.md) |
| dsh 插件、preset、MCP 入口 | [`docs/dsh-integration.md`](docs/dsh-integration.md) |
| 智能体闭环：Goal / Step / Action / Memory | [`docs/agent-loop.md`](docs/agent-loop.md) |
| 故障模式目录（62 条） | [`docs/failure-catalog.md`](docs/failure-catalog.md) |
| 只读面板 | [`docs/dashboard.md`](docs/dashboard.md) |
| 证据检索基线与评测 | [`docs/knowledge-baseline.md`](docs/knowledge-baseline.md) |
| 演练记录（E-04 / E-05 / E-08 / E-09） | [`docs/injection-drill.md`](docs/injection-drill.md)、[`docs/trace-drill.md`](docs/trace-drill.md)、[`docs/offline-acceptance.md`](docs/offline-acceptance.md)、[`docs/e2e-agent.md`](docs/e2e-agent.md) |
| 实现状态、验收项与未达成条目 | [`docs/status.md`](docs/status.md) |
| 部署模板 | [`deploy/`](deploy/) |

中文翻译：[`README.cn.md`](README.cn.md)。翻译不作为事实源，两者冲突时以英文版 `README.md` 为准。

## 状态

P0–P6 已实现并在本机验证。E-01–E-07 与 E-10 有实现与测试证据；E-08 部分达成；E-09（真实模型 E2E）只能手工执行，未接入发布准入检查，因此不满足「全部通过方可发版」。

里程碑细节、验收证据、既有资产巡检的覆盖矩阵与未达成的设计条目见 [`docs/status.md`](docs/status.md)。

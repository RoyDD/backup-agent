# backup-agent

PostgreSQL 备份恢复 Agent 的确定性内核。设计基线见 `../docs/plan-v1.1.md`；架构与流程图见 [`docs/architecture.md`](docs/architecture.md)。

## 状态

P0–P6 里程碑均已完成，范围为**单机本地控制面**：

- P0：领域模型、Plan IR 校验/指纹/重基、`Executor` 端口、SQLite 控制库（Outbox / 租约与 fencing / 对账）、`bkagent inspect`。
- P0.5：57 条故障目录、15 条本地复现、错误分类与预检规则（[`docs/failure-catalog.md`](docs/failure-catalog.md)）。
- P1：`pg_dump` / `psql` 逻辑备份与恢复、Step DAG 执行器、恢复校验（临时库行数 + 列/约束/索引 schema 比对 + `amcheck`）、`bkagent backup|restore|verify`。
- P2：`pg_basebackup` 物理备份、`pg_verifybackup` 完整性校验、PITR 计划（恢复配置、实例启动、promote 断言、失败清理图），`bkagent backup --mode physical` 与 `bkagent pitr`。
- P3：pgBackRest 与 WAL-G 编排（备份/恢复/校验/expire/delete retain）、`pgbackrest-*` 与 `walg-*` 命令；两条链路均完成真实集群验证（见 [`docs/provider-integration-2026-11-12.md`](docs/provider-integration-2026-11-12.md)）。四个 provider 以 §11 `ProviderAdapter` 契约注册（`native-logical` / `native-physical` / `pgbackrest` / `walg`），`bkagent providers [--dsn …]` 列出描述符并探测工具版本与服务器版本矩阵（见 [`docs/provider-contract.md`](docs/provider-contract.md)）。
- P4：GFS 保留（可达性分析，按 target 计算）、运行持久化、`catalog` / `retain` / `report` / `metrics` / `capacity` / `watchdog` / `trace` / `notify-test` 命令、systemd 与 cron 模板。`metrics` 输出 §12 的 7 条序列（`bk_ticket_total`、`bk_attempt_duration_seconds`、`bk_backup_bytes_total`、`bk_verify_result_total`、`bk_outbox_lag_seconds`、`bk_stalled_attempts_total`、`bk_rpo_attainment_ratio`），另有 `bk_artifacts_total`、`bk_artifact_bytes_total`、`bk_attempt_errors_total`、`bk_outbox_pending`、`bk_last_artifact_timestamp_seconds`；`watchdog` 在 reconcile 之后评估 P1–P4 告警阶梯并可推送到 webhook 或 SMTP。`retain --apply` 只把符合策略的 catalog 元数据标记为 tombstone（保留行、路径与 lineage，`bytes` 不回收），需绑定 dry-run digest、`--target`、`--yes`，生产 target 另需双人复核；`asset-set --protected` 的 target 整目标豁免且 apply 拒绝；`catalog --history` 可查看含 tombstone 的行（plan 关联行仍可用 `trace`）；字节回收由 `storage-purge`（tombstoned + managed + 超过宽限期 + 无 live 子节点）与 `storage-gc`（无引用且超期对象）执行，两者默认 dry-run，`--apply` 必须绑定 dry-run digest 与 `--yes`，逐条写审计；provider 仓库仍由 `pgbackrest expire` / `wal-g delete retain` 清理。
- P5：dsh 工具插件（`pg_inspect` / `pg_backup` / `pg_restore` / `pg_verify` / `pg_pitr` / `pg_catalog` / `pg_report` / `kb_search`）、`pg-dba` Preset 与六项技能、安装脚本；工具定义集中在 `tools.js`，同一注册表同时供 dsh 插件与 `bkagent-mcp`（MCP stdio）使用，MCP 下的破坏性工具失败关闭。见 [`docs/dsh-integration.md`](docs/dsh-integration.md)。
- P6：只读 Web 面板（`bkagent dashboard --out|--serve`）：汇总卡片、产物时间线、校验状态、执行记录与过滤；自包含 HTML，无外部资源。

此外实现了一个不属于 P0–P6 里程碑的知识包 `@backup-agent/knowledge`：SAG2 证据检索（SQLite FTS5 + BM25、别名词典、逐轮重排、`primary`/`evidence` 分层）、可插拔打分后端（`lexical` / `command` / `http`，协商失败关闭）、108 题评测集（R@10 50.01%）。它只服务文档问答与排障导航，不参与 Plan 生成。见 [`docs/knowledge-baseline.md`](docs/knowledge-baseline.md)。

### 验收项

`pnpm test` 为 61 个测试文件 / 682 个用例，`pnpm -r typecheck` 全部通过。

- **E-01 至 E-07、E-10**：有实现与测试证据。E-01 的可追溯性落在数据面（`AssetDescriptor` + Plan/Attempt/Artifact + `trace` 血缘），模型自然语言结论本身不做机器校验。E-03 的越权处置是「拒绝并写 `authorization.denied` 审计事件」，权限本身由 principal 的数据库凭据与操作系统身份承担。E-05 见 [`docs/trace-drill.md`](docs/trace-drill.md)，E-04 见 [`docs/injection-drill.md`](docs/injection-drill.md) 与 `packages/engine-postgres/test/injection.integration.test.ts`，E-07 由 `pnpm verify:skills` 的 MANIFEST 哈希守护。E-10 的审批按操作系统身份去重，同一 OS 用户无法用两个标签满足双人复核。
- **E-08**：`scripts/offline-drill.sh` 覆盖 inspect / backup / verify / report / dashboard，**部分达成**——CLI 没有独立 `plan` 子命令（规划内嵌于各命令），演练也未覆盖受控恢复（[`docs/offline-acceptance.md`](docs/offline-acceptance.md) §Not covered）。
- **E-09**：真实模型 E2E 有 2026-11-12 的成功记录（[`docs/e2e-agent.md`](docs/e2e-agent.md)），但只能手工执行 `scripts/e2e-agent.mjs`，**未接入任何门禁**，因此不满足「全绿方可发版」。

### 巡检既有资产（含非 agent 产物）

控制面能对已有备份做「查状态、查内容」，但覆盖范围按产物形态与位置分档，且不包含调度：

| 能力 | 入口 | 覆盖 | 限制 |
|---|---|---|---|
| 台账 | `catalog`（含 `--history`）、`asset-list`、`asset-rpo` | 目录行、tombstone、每 target 的 VRP 与 RPO 达标情况 | 只读控制库元数据，不触字节 |
| 状态巡检 | `watchdog`（cron 每 5 分钟） | P1 无 VRP、P2 连续失败、P3 最近 V2+ 超过 7 天、P4 容量；可推 webhook / SMTP | 只告警，不发起校验 |
| 逻辑转储复检 | `verify --dsn … --input <路径>` | 任意本地 custom / plain / `-Fd` 目录，恢复到临时库后做行数 + schema + `amcheck`，产出 V2 | 需要可达的目标实例；非本地位置（`s3://…`、`<transport>:<path>`）不可读；证据只写回「路径完全相同」的最近一行，未入册时仅提示 |
| 外部资产入册 | `artifact-add --target … --provider … --kind … --path … [--parent <id>] [--verified-level V0..V3 --checksum <sha256>]` | 外部产物（他机/他工具的历史转储、provider 仓库条目）可入册并纳入台账与告警 | 等级是**自证**：`--checksum` 只校验 64-hex 格式，不与字节比对；`--provider` 必须是四个已注册 ID，否则 `retain --apply` 整批拒绝（`unknown-provider`） |
| 外部 provider 仓库 | `exec -- pgbackrest info` | 原始 JSON 可见 | 解析器 `catalogEntriesFromPgBackRestInfo` 未接 CLI，仓库内容不入目录 |
| 物理备份 | — | `pg_verifybackup` 只在 `backup --mode physical --format plain` 的计划内执行一次（V0） | 无事后复检入口；tar 形态明确跳过校验 |
| 字节完整性 | — | 上传与 `verify` 内部会计算 sha256 | 没有「重算并与目录记录比对」的命令，静默篡改只能在恢复失败时暴露 |

对非 agent 产物的实际结论：**逻辑转储可以巡检**（`verify --input`），**物理备份与 provider 仓库只能登记、不能验证**；`storage-gc` / `storage-purge` 只处理 managed storage，外部路径记为 `outside-storage` 跳过，不会误删。

### 未达成的设计条目

- **dsh 内嵌面板**未做；P6 为独立只读页面（基线 v1.1 已明确后置）。
- **PITR 窗口**只有「基础备份 consistent point → 最后归档段」的 LSN 区间预检（`engine-postgres/src/pitr-window.ts`）：WAL 缺口枚举、跨时间线 `.history` 校验、与 retention 求交集均未实现；时间/name/xid 目标由恢复后断言判定。也没有真实集群上的 PITR 集成用例（方案 §15 要求「恢复至中间时间点，断言数据边界」），只有 Plan 级单测与手工 provider 恢复。
- **校验分级**：V2 已真实执行（schema + 行数 + `amcheck`，扩展不可用时记录 `available:false`）；V3 业务冒烟 SQL 用例集缺失；V0 默认 `--no-parse-wal`。
- **状态机**：`Plan.superseded` 有迁移定义但无生产写入者；`targetOid` 变化按配置漂移重基，而非 §5.4 要求的「目标身份变化即终止」。
- **产物与存储**：目录形态产物（`pg_dump -Fd`、`pg_basebackup -Fp`）不能上传 `Storage`；远端计划产物记为 `<transport>:<path>`，字节不回传控制面；SMTP 无 STARTTLS。
- **资产巡检未闭环**：没有 `verify --artifact <id>`，产物落在 `s3` 或远端时无法复检；物理备份没有事后 `pg_verifybackup`；§8 的「每日抽样 V2 / 每周 V3」没有调度；没有字节完整性复检命令，`artifact-add` 的等级不校验字节（自证）。
- **外部仓库不可入目录**：pgBackRest / WAL-G 的 `catalog` 操作只存在于 `ProviderAdapter` 契约，没有对应 CLI 动词，外部仓库的条目只能经 `artifact-add` 手工登记。
- **兼容矩阵**：PG14–17 × 四类 provider 的夜间矩阵未接入 CI，实测环境为 PG16/17，provider 链路为手工验证。
- **质量门禁**：语句/分支覆盖率、变异得分、flaky 率没有对应工具执行；故障注入（F-01–F-06）只有错误分类单测，混沌与状态机模型检验未做。`Executor` 共享契约套件目前只由 `LocalExecutor` 复用（C-02 断言 env 透传，与远端不转发 env 的设计冲突），`ssh` / `kubectl` 只有各自的传输用例。
- **凭据**：`secretRef` 只是方案 §10 的目标，代码中没有对应类型或字段；实际实现是子进程环境变量 + principal 注册表里的 `dsnEnv`。
- **P5 工具面**：provider 类命令（`pgbackrest-*` / `walg-*` / `retain` / `metrics` / `storage-*` 等）仍只经 CLI 或 `bash` 调用；MCP 无审批通道，因此 MCP 下不能执行恢复。
- **远端目标**：SSH/kubectl 执行器与传输已验证，但 10.1.31.125 尚未安装 PostgreSQL，远程数据库目标与 rustfs S3 目标仍待环境侧推进。

## 结构

```
packages/
  core/                 @backup-agent/core（零运行时依赖）
    src/domain/         标识、风险、能力、资产、主体、模型策略、Plan、状态机
    src/ports/          Executor / Repository / Engine / Provider / Storage / Clock
    src/plan/           校验、指纹、重基
    src/executor/       local / ssh / kubectl 执行器、POSIX 引号、错误分类
    src/runner/         谓词求值、Step DAG 执行（含 cleanup 图）、重试、检查点
    src/security/       破坏性授权、four-eyes、资产降级、principal 注册表
    src/ops/            保留、报表、指标、容量、告警、通知、artifact 摘要与 GC
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

## 开发

```sh
pnpm install
pnpm test                        # vitest run；集成用例需本地 Docker
pnpm -r --parallel typecheck
pnpm bkagent inspect --dsn 'postgres://user:pass@127.0.0.1:5432/postgres' --format text
pnpm bkagent providers --dsn 'postgres://user:pass@127.0.0.1:5432/postgres' --format text
pnpm bkagent backup  --dsn '...' --database app --out /backups/app.dump --format custom
pnpm bkagent restore --dsn '...' --input /backups/app.dump --database app_restored --create-database --yes
pnpm bkagent verify  --dsn '...' --input /backups/app.dump
pnpm bkagent backup  --dsn '...' --mode physical --out /backups/base --format plain
pnpm bkagent pitr    --dsn '...' --data-dir /restore --port 55417 --log /tmp/rec.log \
                     --restore-command 'cp /archive/%f %p' --target-time '2026-01-01 00:00:00+00' --yes
pnpm bkagent pgbackrest-backup  --config /etc/pgbackrest.conf --stanza main --ensure-stanza
pnpm bkagent pgbackrest-restore --config /etc/pgbackrest.conf --stanza main --data-dir /restore --yes
pnpm bkagent walg-backup  --data-dir /var/lib/postgresql/data
pnpm bkagent walg-restore --data-dir /restore --yes
pnpm bkagent backup --transport ssh --ssh-host dba@db1 --known-hosts /etc/backup-agent/known_hosts \
  --dsn 'postgres://backup@127.0.0.1:5432/app' --database app --out /var/backups/app.dump
pnpm bkagent exec --transport ssh --host dba@db1 --known-hosts /etc/backup-agent/known_hosts -- pgbackrest info
pnpm bkagent outbox-dispatch --db .bkagent/control.db --limit 50
pnpm bkagent watchdog --db .bkagent/control.db
pnpm bkagent report   --db .bkagent/control.db --since 7d
pnpm bkagent metrics  --db .bkagent/control.db
pnpm bkagent retain   --db .bkagent/control.db --daily 7 --weekly 4 --monthly 12 --target 127.0.0.1:5432/app
pnpm bkagent retain   --db .bkagent/control.db --daily 7 --weekly 4 --monthly 12 --target 127.0.0.1:5432/app --apply --yes --digest <digest>
pnpm bkagent dashboard --db .bkagent/control.db --out /tmp/dashboard.html
pnpm bkagent asset-set   --db .bkagent/control.db --target 127.0.0.1:5432/app --engine postgres \
                         --environment production --owner dba --criticality high \
                         --data-classification internal --rpo-minutes 1440 --rto-minutes 240
pnpm bkagent approve     --db .bkagent/control.db --target 127.0.0.1:5432/app --digest <digest> --approver alice
pnpm bkagent approvals   --db .bkagent/control.db --target 127.0.0.1:5432/app --digest <digest>
pnpm bkagent trace       --db .bkagent/control.db --plan <planId>
pnpm build:cli                   # dist/bkagent.mjs + dist/migrations
pnpm build:knowledge             # dist/bkagent-knowledge.mjs
pnpm verify:skills               # 校验 presets/pg-dba/skills/MANIFEST.json
```

`inspect` 通过 `psql` 读取实例信息；所有逻辑恢复都按破坏性操作处理（输入可包含 `DROP` 等 SQL），须显式 `--yes`、登记目标 Asset，生产目标还需双人复核。凭据仅经子进程环境变量传递，不出现在 argv 或输出中。

集成用例（`packages/engine-postgres/test/*.integration.test.ts`）需要本地 Docker 上的 PostgreSQL：16 在 `55416`、17 在 `55417`，DSN 默认 `postgres://postgres:verify_pw@127.0.0.1:55416/postgres`（可用 `BK_TEST_DSN` 覆盖）。实例不可达时用例会 `context.skip`，文件仍计入 passed——确认是否真的执行用 `pnpm exec vitest run <file> --reporter=verbose`。S3 只有契约级单测（注入 `fetch`），本地 MinIO（`59000-59001`）用于手工验证，没有 S3 集成用例。

知识库（SAG2 证据检索）：

```sh
pnpm --filter @backup-agent/knowledge index    # 重建 var/knowledge.sqlite
pnpm --filter @backup-agent/knowledge ask "为什么归档失败后 PITR 窗口会缩短"
pnpm --filter @backup-agent/knowledge eval
pnpm --filter @backup-agent/knowledge stats
```

MCP 入口：`node packages/dsh-plugin/mcp.js`（`bin` 名 `bkagent-mcp`，默认调用 `dist/bkagent.mjs`，可用 `BKAGENT_CLI` 覆盖）。

## 约束

- 确定性核心为状态唯一写入者；智能体层只做意图解析与呈现。
- `Plan` 为 Step DAG，每步必须声明 `idempotencyKey`，执行前重新求值前置条件；可选 `cleanup` 图只在失败时执行，用于补偿（例如 PITR 失败后停止实例），清理失败会明确报告且不覆盖原始失败。`Plan.requires` 声明该计划所需能力，按 provider 声明集失败关闭。
- 外部副作用与状态迁移同事务写入 Outbox；`bkagent outbox-dispatch` 独立投递，至少一次，接收端按 `outbox_id` 去重（不承诺 exactly-once）。
- 租约带单调递增 fencing token；过期写入被拒绝。
- 破坏性计划仅来自 `DESTRUCTIVE_PLAN_COMMANDS`；计划声明的风险低于 `destructive` 会被拒绝执行（`risk-understated`），拒绝事件写入审计 Outbox。
- 审批记录同时保存人类标签与操作系统身份；双人复核按身份去重，同一 OS 用户无法用两个标签满足双人复核。
- 资产降级（生产 → 其他环境、撤销 `protected`、降低 criticality）需 `--yes` 与两条绑定「资产变更 digest」的审批。
- V2/V3 证据只能由通过的 `bkagent verify`（写入等级与内容摘要）或 `artifact-add --verified-level … --checksum <sha256>` 进入目录。
- 控制库仅经 `Repository` 端口访问；迁移目录默认在 bundle 旁，可用 `BKAGENT_MIGRATIONS` 指定；新增迁移必须同时加入 `sqlite-repository.ts` 的硬编码清单，否则 `build:cli` 产物缺表。
- 检查点按 step 的 `checkpoint` 语义落盘：`after` 可跳过，`none` / `before` 在 `--resume` 时重跑；未传 `--resume` 时只写不读。
- PITR 的 LSN 目标在执行前对照 `backup_label` 的 consistent point 与 `pg_stat_archiver.last_archived_wal` 判断窗口，越界即拒绝；时间/name/xid 目标由恢复后断言判定。
- 执行器：`local` / `ssh` / `kubectl` 均为 argv-only；`Plan.transport` 记录执行位置，`--transport ssh|kubectl` 全局选择（`--ssh-host` / `--known-hosts`，或 `--kubectl-pod`）。SSH 强制严格主机密钥，远端 argv 只经 POSIX 单引号传输；远端计划不转发环境变量（带 env 的计划在执行前被拒绝），探测时连接参数以 argv 传入 `psql`，密码只来自目标机凭据（`.pgpass`/peer/GSSAPI）。
- 存储：`Storage` 端口提供 `fs` / `nfs` / `s3`（SigV4，无 SDK）实现。`backup --storage-kind …` 把产物写入该 Storage 并在 artifact 行记录位置 + sha256（上传失败即判运行失败）；`artifact-upload` 可迁移既有行。远端计划的产物记为 `<transport>:<path>`（字节在目标机，控制面不可读）。目录形态产物暂不支持上传。
- 能力协商失败关闭：provider 未声明的能力明确报错，不静默降级；工具版本只经 `--version` 或 SQL 探测，不信任配置声明（§11）。
- provider 仓库归 provider（ADR-003）：保留只能走 `pgbackrest expire` / `wal-g delete retain`，禁止直接删除文件；仅自管 `storage` 允许直接删除对象。
- 通知：webhook 与 SMTP（纯文本、AUTH PLAIN、无 STARTTLS）二选一，由 `BKAGENT_WEBHOOK_URL` 或 `BKAGENT_SMTP_*` 配置；`notify-test --smtp` 可自检。
- 知识检索只用于开发/运维问答（ADR-009 不引入向量库），不参与 Plan 生成；故障目录仍是编译期输入（ADR-010）。
- 使用 `node:sqlite`（Node >= 22.5，仍标记为实验特性）。

## 文档

| 主题 | 文件 |
|---|---|
| 架构、执行/存储/通知、授权门禁、Outbox | [`docs/architecture.md`](docs/architecture.md) |
| §11 引擎/provider 契约与四个 provider | [`docs/provider-contract.md`](docs/provider-contract.md) |
| dsh 插件、Preset、MCP 入口 | [`docs/dsh-integration.md`](docs/dsh-integration.md) |
| 故障模式目录（57 条） | [`docs/failure-catalog.md`](docs/failure-catalog.md) |
| 只读面板 | [`docs/dashboard.md`](docs/dashboard.md) |
| 证据检索基线与评测 | [`docs/knowledge-baseline.md`](docs/knowledge-baseline.md) |
| 演练记录（E-04 / E-05 / E-08 / E-09） | [`docs/injection-drill.md`](docs/injection-drill.md)、[`docs/trace-drill.md`](docs/trace-drill.md)、[`docs/offline-acceptance.md`](docs/offline-acceptance.md)、[`docs/e2e-agent.md`](docs/e2e-agent.md) |

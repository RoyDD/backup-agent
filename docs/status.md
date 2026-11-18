# 实现状态

范围为**单机本地控制面**。状态与未达成条目以本文件与 `plan-v1.1.md` §20.1（实现差距）为准；设计基线见 `../docs/plan-v1.1.md`，架构见 [`architecture.md`](architecture.md)。

## 里程碑

P0–P6 里程碑均已完成：

- P0：领域模型、Plan IR 校验/指纹/重基、`Executor` 端口、SQLite 控制库（Outbox / 租约与 fencing / 对账）、`bkagent inspect`。
- P0.5：62 条故障目录、15 条本地复现、错误分类与预检规则（[`failure-catalog.md`](failure-catalog.md)）。
- P1：`pg_dump` / `psql` 逻辑备份与恢复、Step DAG 执行器、恢复校验（临时库行数 + 列/约束/索引 schema 比对 + `amcheck`）、`bkagent backup|restore|verify`。
- P2：`pg_basebackup` 物理备份、`pg_verifybackup` 完整性校验、PITR 计划（恢复配置、实例启动、promote 断言、失败清理图），`bkagent backup --mode physical` 与 `bkagent pitr`。
- P3：pgBackRest 与 WAL-G 编排（备份/恢复/校验/expire/delete retain）、`pgbackrest-*` 与 `walg-*` 命令；两条链路均完成真实集群验证（见 [`provider-integration-2026-11-12.md`](provider-integration-2026-11-12.md)）。四个 provider 以 §11 `ProviderAdapter` 契约注册（`native-logical` / `native-physical` / `pgbackrest` / `walg`），`bkagent providers [--dsn …]` 列出描述符并探测工具版本与服务器版本矩阵（见 [`provider-contract.md`](provider-contract.md)）。
- P4：GFS 保留（可达性分析，按 target 计算）、运行持久化、`catalog` / `retain` / `report` / `metrics` / `capacity` / `watchdog` / `trace` / `notify-test` 命令、systemd 与 cron 模板。`metrics` 输出 §12 的 7 条序列（`bk_ticket_total`、`bk_attempt_duration_seconds`、`bk_backup_bytes_total`、`bk_verify_result_total`、`bk_outbox_lag_seconds`、`bk_stalled_attempts_total`、`bk_rpo_attainment_ratio`），另有 `bk_artifacts_total`、`bk_artifact_bytes_total`、`bk_attempt_errors_total`、`bk_outbox_pending`、`bk_last_artifact_timestamp_seconds`；`watchdog` 在 reconcile 之后评估 P1–P4 告警阶梯并可推送到 webhook 或 SMTP。`retain --apply` 只把符合策略的 catalog 元数据标记为 tombstone（保留行、路径与 lineage，`bytes` 不回收），需绑定 dry-run digest、`--target`、`--yes`，生产 target 另需双人复核；`asset-set --protected` 的 target 整目标豁免且 apply 拒绝；`catalog --history` 可查看含 tombstone 的行（plan 关联行仍可用 `trace`）；字节回收由 `storage-purge`（tombstoned + managed + 超过宽限期 + 无 live 子节点）与 `storage-gc`（无引用且超期对象）执行，两者默认 dry-run，`--apply` 必须绑定 dry-run digest 与 `--yes`，逐条写审计；provider 仓库仍由 `pgbackrest expire` / `wal-g delete retain` 清理。
- P5：dsh 工具插件（`pg_inspect` / `pg_backup` / `pg_restore` / `pg_verify` / `pg_pitr` / `pg_catalog` / `pg_report` / `kb_search`）、`pg-dba` Preset 与六项技能、安装脚本；工具定义集中在 `tools.js`，同一注册表同时供 dsh 插件与 `bkagent-mcp`（MCP stdio）使用，MCP 下的破坏性工具失败关闭。见 [`dsh-integration.md`](dsh-integration.md)。同一注册表另暴露目标/记忆闭环的四个工具（`bk_goal` / `bk_step_run` / `bk_remediate` / `bk_recall`）：拆解、进度与记忆落控制库，步骤审批只能在 CLI 侧由人工完成，见 [`agent-loop.md`](agent-loop.md)。
- P6：只读 Web 面板（`bkagent dashboard --out|--serve`）：汇总卡片、产物时间线、校验状态、执行记录与过滤；自包含 HTML，无外部资源。

此外实现了一个不属于 P0–P6 里程碑的知识包 `@backup-agent/knowledge`：SAG2 证据检索（SQLite FTS5 + BM25、别名词典、逐轮重排、`primary`/`evidence` 分层）、可插拔打分后端（`lexical` / `command` / `http`，协商失败关闭）、108 题评测集（R@10 49.08%）。它只服务文档问答与排障导航，不参与 Plan 生成。见 [`knowledge-baseline.md`](knowledge-baseline.md)。

## 验收项

`pnpm test` 为 70 个测试文件 / 837 个用例，`pnpm -r typecheck` 全部通过。

- **E-01 至 E-07、E-10**：有实现与测试证据。E-01 的可追溯性落在数据面（`AssetDescriptor` + Plan/Attempt/Artifact + `trace` 血缘），模型自然语言结论本身不做机器校验。E-03 的越权处置是「拒绝并写 `authorization.denied` 审计事件」，权限本身由 principal 的数据库凭据与操作系统身份承担。E-05 见 [`trace-drill.md`](trace-drill.md)，E-04 见 [`injection-drill.md`](injection-drill.md) 与 `packages/engine-postgres/test/injection.integration.test.ts`，E-07 由 `pnpm verify:skills` 的 MANIFEST 哈希守护。E-10 的审批按操作系统身份去重，同一 OS 用户无法用两个标签满足双人复核。
- **E-08**：`scripts/offline-drill.sh` 覆盖 inspect / backup / verify / report / dashboard，**部分达成**——单命令没有独立 `plan` 子命令（规划内嵌于各命令；多步规划由 `goal plan` 持久化，见 [`agent-loop.md`](agent-loop.md)），演练也未覆盖受控恢复与目标闭环（[`offline-acceptance.md`](offline-acceptance.md) §Not covered）。
- **E-09**：真实模型 E2E 有 2026-11-12 的成功记录（[`e2e-agent.md`](e2e-agent.md)），但只能手工执行 `scripts/e2e-agent.mjs`，**未接入任何发布准入检查**，因此不满足「全部通过方可发版」。
- **闭环（Goal/Step/Action/Memory）**：有单测与针对真实 PostgreSQL 的集成用例（`packages/cli/test/goal.integration.test.ts` 覆盖成功路径、permanent 失败→`replan`→成功、未审批破坏性步骤被拒三条路径），`dist/bkagent.mjs` 与 MCP 入口也已手工验证。但**没有**由真实模型驱动这条闭环的 E2E；E-09 仍只覆盖单命令轨迹，闭环的模型侧行为没有回归门禁。

## 巡检既有资产（含非 agent 产物）

控制面能对已有备份做「查状态、查内容」，但覆盖范围按产物形态与位置区分，且不包含调度：

| 能力 | 入口 | 覆盖 | 限制 |
|---|---|---|---|
| 台账 | `catalog`（含 `--history`）、`asset-list`、`asset-rpo` | 目录行、tombstone、每 target 的 VRP 与 RPO 达标情况 | 只读控制库元数据，不触字节 |
| 状态巡检 | `watchdog`（cron 每 5 分钟） | P1 无 VRP、P2 连续失败、P3 最近 V2+ 超过 7 天、P4 容量；可推 webhook / SMTP | 只告警，不发起校验 |
| 逻辑转储复检 | `verify --dsn … --input <路径>` | 任意本地 custom / plain / `-Fd` 目录，恢复到临时库后做行数 + schema + `amcheck`，产出 V2 | 需要可达的目标实例；非本地位置（`s3://…`、`<transport>:<path>`）不可读；证据只写回「路径完全相同」的最近一行，未入册时仅提示 |
| 外部资产入册 | `artifact-add --target … --provider … --kind … --path … [--parent <id>] [--verified-level V0..V3 --checksum <sha256>]` | 外部产物（他机或他工具的历史转储、provider 仓库条目）可入册并纳入台账与告警 | 等级是**自证**：`--checksum` 只校验 64-hex 格式，不与字节比对；`--provider` 必须是四个已注册 ID，否则 `retain --apply` 整批拒绝（`unknown-provider`） |
| 外部 provider 仓库 | `exec -- pgbackrest info` | 原始 JSON 可见 | 解析器 `catalogEntriesFromPgBackRestInfo` 未接 CLI，仓库内容不入目录 |
| 物理备份 | — | `pg_verifybackup` 只在 `backup --mode physical --format plain` 的计划内执行一次（V0） | 无事后复检入口；tar 形态明确跳过校验 |
| 字节完整性 | — | 上传与 `verify` 内部会计算 sha256 | 没有「重算并与目录记录比对」的命令，静默篡改只能在恢复失败时暴露 |

对非 agent 产物的结论：**逻辑转储可以巡检**（`verify --input`），**物理备份与 provider 仓库只能登记、不能验证**；`storage-gc` / `storage-purge` 只处理 managed storage，外部路径记为 `outside-storage` 跳过，不会误删。

## 未达成的设计条目

- **dsh 内嵌面板**未做；P6 为独立只读页面（基线 v1.1 已明确后置）。
- **PITR 窗口**只有「基础备份 consistent point → 最后归档段」的 LSN 区间预检（`engine-postgres/src/pitr-window.ts`）：WAL 缺口枚举、跨时间线 `.history` 校验、与 retention 求交集均未实现；时间/name/xid 目标由恢复后断言判定。也没有真实集群上的 PITR 集成用例（方案 §15 要求「恢复至中间时间点，断言数据边界」），只有 Plan 级单测与手工 provider 恢复。
- **校验分级**：V2 已真实执行（schema + 行数 + `amcheck`，扩展不可用时记录 `available:false`）；V3 业务冒烟 SQL 用例集缺失；V0 默认 `--no-parse-wal`。
- **状态机**：`Plan.superseded` 有迁移定义但无生产写入者；`targetOid` 变化按配置漂移重基，而非 §5.4 要求的「目标身份变化即终止」。
- **产物与存储**：目录形态产物（`pg_dump -Fd`、`pg_basebackup -Fp`）不能上传 `Storage`；远端计划产物记为 `<transport>:<path>`，字节不回传控制面；SMTP 无 STARTTLS。
- **资产巡检覆盖不全**：没有 `verify --artifact <id>`，产物落在 `s3` 或远端时无法复检；物理备份没有事后 `pg_verifybackup`；§8 的「每日抽样 V2 / 每周 V3」没有调度；没有字节完整性复检命令，`artifact-add` 的等级不校验字节（自证）。
- **外部仓库不可入目录**：pgBackRest / WAL-G 的 `catalog` 操作只存在于 `ProviderAdapter` 契约，没有对应 CLI 动词，外部仓库的条目只能经 `artifact-add` 手工登记。
- **兼容矩阵**：PG14–17 × 四类 provider 的夜间矩阵未接入 CI，实测环境为 PG16/17，provider 链路为手工验证。
- **质量准入检查**：语句/分支覆盖率、变异得分、不稳定用例率没有对应工具执行；故障注入（F-01–F-06）只有错误分类单测，混沌与状态机模型检验未做。`Executor` 共享契约套件目前只由 `LocalExecutor` 复用（C-02 断言 env 透传，与远端不转发 env 的设计冲突），`ssh` / `kubectl` 只有各自的传输用例。
- **凭据**：`secretRef` 只是方案 §10 的目标，代码中没有对应类型或字段；实际实现是子进程环境变量 + principal 注册表里的 `dsnEnv`。
- **P5 工具面**：provider 类命令仍未各自暴露为一等工具；其中 `pgbackrest-*` / `walg-*` / `metrics` / `asset-list` / `asset-rpo` 已进入 `ACTION_COMMANDS`，可由 `goal` 步骤派发，`retain` / `storage-*` / `asset-set` 仍只经 CLI 或 `bash` 调用。MCP 无审批通道，因此 MCP 下不能执行恢复。
- **远端目标**：SSH/kubectl 执行器与传输已验证，但 10.1.31.125 尚未安装 PostgreSQL，远程数据库目标与 rustfs S3 目标仍待环境侧推进。

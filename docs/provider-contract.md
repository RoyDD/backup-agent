# Provider Contract (§11)

Every engine extension is described by two descriptors and one adapter
interface. The interface exists so a new provider is accepted only after it
passes the same contract suite as the existing ones — not because the CLI
happened to work once.

## Descriptors

| 描述符 | 内容 |
|---|---|
| `EngineDescriptor` | 引擎 ID、能力集合、支持的服务器版本区间、所需外部工具及最低版本 |
| `ProviderDescriptor` | provider ID、所属引擎、能力集合、仓库所有权（`provider-owned` / `managed`）、支持版本区间、工具清单 |

两者都在 `packages/core/src/ports/provider.ts`。PostgreSQL 引擎的描述符在 `packages/engine-postgres/src/descriptor.ts`（`POSTGRES_ENGINE_DESCRIPTOR`，版本矩阵 14–17）。

工具版本只经 `--version` 探测，不依据配置声明假定；探测失败或输出无法解析一律视为未满足（`TOOL_MISSING`），能力未声明一律拒绝（`CAPABILITY`）。

## 八个操作

| 操作 | 职责 | 不实现时 |
|---|---|---|
| `inspect` | 读取实例事实（版本、角色、WAL、归档、库清单） | 必须实现 |
| `plan` | 按操作分派到下面四个 plan 构造器 | 必须实现 |
| `preflight` | 版本矩阵 + 能力协商 + 工具版本，返回 issues 而不抛错 | 必须实现 |
| `backup` | 生成备份 `Plan` | 抛 `UNSUPPORTED_OPERATION` |
| `restore` | 生成恢复 / PITR `Plan` | 抛 `UNSUPPORTED_OPERATION` |
| `verify` | 生成校验 `Plan`（V0/V1 级，例如 `pg_verifybackup`、`pg_restore --list`） | 抛 `UNSUPPORTED_OPERATION` |
| `catalog` | 读取 provider 自己的仓库清单（例：`pgbackrest info --output=json`） | 抛 `UNSUPPORTED_OPERATION` |
| `prune` | 生成 provider 侧清理 `Plan`（`pgbackrest expire` / `wal-g delete retain`） | 抛 `UNSUPPORTED_OPERATION` |

`plan(op, …)` 必须与对应动词调用同一构造器；契约套件会比对两者产出的 `steps`，防止两条构造路径漂移。

不实现的操作用 `ProviderOperationError('UNSUPPORTED_OPERATION', …)` 明确拒绝：能力协商失败关闭，不静默降级（§11、R5）。

## 当前注册的 provider

| provider ID | 所有权 | 能力 | 工具 | 已实现的操作 |
|---|---|---|---|---|
| `native-logical` | managed | logical, verify-restore | psql ≥14, pg_dump ≥14, pg_restore ≥14 | inspect, preflight, backup, restore, verify |
| `native-physical` | managed | physical, pitr, verify-restore | psql ≥14, pg_basebackup ≥14, pg_verifybackup ≥13 | inspect, preflight, backup, restore(PITR), verify |
| `pgbackrest` | provider-owned | physical, incremental, wal-archive, verify-restore | psql ≥14, pgbackrest ≥2.45 | inspect, preflight, backup, restore, verify, catalog, prune |
| `walg` | provider-owned | physical, wal-archive | psql ≥14, wal-g ≥2.0 | inspect, preflight, backup, restore, prune |

`provider-owned` 表示字节归 provider（ADR-003）：控制面只生成 `prune` 计划，从不直接删除对象；`managed` 的保留仍走 catalog tombstone。

## 检查就绪状态

```sh
bkagent providers                       # 只列描述符，不连接服务器
bkagent providers --dsn "$BKAGENT_DSN"  # 探测工具版本 + 版本矩阵，未就绪退出 1
bkagent providers --dsn "$BKAGENT_DSN" --format text
# 目标机上的工具版本才重要时，把同一个 transport 交给它：
bkagent providers --transport ssh --ssh-host dba@db1 --known-hosts /etc/backup-agent/known_hosts \
  --dsn "$BKAGENT_DSN" --format text
```

## 契约套件

`packages/core/test/contract/provider-contract.suite.ts` 导出 `defineProviderContractSuite(name, options)`，由各 provider 的测试文件调用（示例：`packages/engine-postgres/test/provider-native-contract.test.ts`、`provider-remote-contract.test.ts`）。用例覆盖：

- P-01 描述符自洽（provider 能力 ⊆ engine 能力、版本区间、工具声明）；
- P-02 八个操作都存在；
- P-03 每个已实现操作产出的 `Plan` 能通过 `validatePlan`，且 `Plan.requires` ⊆ provider 能力；
- P-04 未实现操作抛出 `UNSUPPORTED_OPERATION`（动词与 `plan` 分派两条路径）；
- P-05 工具齐备时 preflight 通过；
- P-06/P-07 工具缺失、版本过低失败关闭；
- P-08 服务器主版本越界被拒；
- P-09 未声明的能力请求被拒；
- P-10 `catalog` 要么返回本 provider 的清单，要么明确拒绝。

`*.suite.ts` 不被 vitest 直接收集，必须由实现侧测试 import —— 与 `defineExecutorContractSuite` 的约定一致。

## 新增 provider 的清单

1. 在 `packages/engine-postgres/src/<provider>.ts` 导出 `ProviderAdapter<...>`：descriptor、`inspect`（复用 `probePostgres`）、`preflight`（复用 `preflightProvider`）、四个 plan 构造器、`catalog`/`prune`（不支持则 `unsupportedOperation`）。
2. 在 `providers.ts` 注册（key = `Plan.provider` 字符串）。
3. 新增测试文件调用 `defineProviderContractSuite`，并为 provider 特有的解析逻辑（如 catalog JSON）加单元用例。
4. `pnpm -r typecheck && pnpm test` 通过；涉及技能文件时重跑 `node scripts/skills-manifest.mjs`。

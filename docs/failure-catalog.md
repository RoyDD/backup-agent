# PostgreSQL 备份恢复故障模式目录 v1.0

- 状态：P0.5 产出，待评审冻结
- 日期：2026-11-11
- 适用范围：PostgreSQL 14–17；provider 覆盖 native-logical、native-physical、pgBackRest、WAL-G（provider 专属条目标注为文献级）
- 事实源：`docs/plan-v1.1.md`（ADR-010：本目录为编译期输入）

本目录不是运行期检索对象。预检规则、错误分类与测试用例由条目派生；运行期以退出码、SQLSTATE 与 stderr 签名做确定性匹配，再由智能体解释。

## 1. 统计

| 系列 | 范围 | 条目数 | 已复现 |
|---|---|---|---|
| E | 环境与权限 | 11 | 3 |
| S | 备份 | 10 | 3 |
| R | 恢复 | 12 | 3 |
| P | 时间点恢复 | 8 | 2 |
| V | 校验 | 8 | 2 |
| A | Agent 层 | 13 | 2 |
| **合计** | | **62** | **15** |

复现证据见 [`failure-catalog/evidence-2026-11-11.md`](failure-catalog/evidence-2026-11-11.md)。复现状态：`R` = 本地复现；`D` = 文献级（desk），尚未复现。

## 2. E — 环境与权限

| ID | 触发条件 | 可观测签名 | 预检 | 分类 | 复现 |
|---|---|---|---|---|---|
| E-01 | 密码错误 | `FATAL: password authentication failed`，psql exit 2 | PR-01 | manual | R |
| E-02 | 角色不存在 | scram 下与 E-01 同签名（防枚举） | PR-01 | manual | R |
| E-03 | 数据库不存在 | `FATAL: database "x" does not exist`，exit 2 | PR-02 | permanent | R |
| E-04 | `pg_hba.conf` 无匹配项 | `no pg_hba.conf entry for host` | PR-03 | manual | D |
| E-05 | 备份角色无复制权限 | `must be superuser or replication role` | PR-04 | manual | D |
| E-06 | `.pgpass` 权限过宽 | `password file ... has group or world access` | PR-05 | manual | D |
| E-07 | 磁盘或 inode 耗尽 | `No space left on device` / `ENOSPC` | PR-06 | manual | D |
| E-08 | 文件描述符耗尽 | `Too many open files` | PR-07 | transient | D |
| E-09 | 连接数耗尽 | SQLSTATE `53300`，`too many clients already` | PR-08 | transient | D |
| E-10 | 时钟或时区漂移 | PITR 目标偏移；租约提前失效 | PR-09 | manual | D |
| E-11 | SSH 主机密钥变更 | `Host key verification failed` | PR-10 | manual | D |

## 3. S — 备份

| ID | 触发条件 | 可观测签名 | 预检 | 分类 | 复现 |
|---|---|---|---|---|---|
| S-01 | 目标库不存在 | `FATAL: database "x" does not exist`，pg_dump exit 1 | PR-02 | permanent | R |
| S-02 | 表权限不足 | `permission denied for table`（SQLSTATE 42501） | PR-11 | manual | R |
| S-03 | 锁等待超时 | `canceling statement due to statement timeout`（57014） | PR-12 | transient | R |
| S-04 | pg_dump 版本低于服务器 | `server version: ... pg_dump: ...` | PR-13 | permanent | D |
| S-05 | 备份期间并发 DDL | `tuple concurrently updated` / `cache lookup failed` | PR-14 | manual | D |
| S-06 | 长事务导致 WAL 膨胀 | `pg_stat_activity.xact_start` 超阈 | PR-15 | transient | D |
| S-07 | 复制槽阻塞 WAL 回收 | `pg_replication_slots.restart_lsn` 落后 | PR-16 | manual | D |
| S-08 | `archive_command` 持续失败 | `pg_stat_archiver.failed_count` 增长 | PR-17 | manual | D |
| S-09 | tablespace 路径缺失 | `directory ... does not exist` | PR-18 | manual | D |
| S-10 | basebackup 连接中断 | `connection reset` / `could not connect` | PR-19 | transient | D |

## 4. R — 恢复

| ID | 触发条件 | 可观测签名 | 预检 | 分类 | 复现 |
|---|---|---|---|---|---|
| R-01 | 转储版本高于 pg_restore | `unsupported version (1.16) in file header` | PR-13 | permanent | R |
| R-02 | 属主角色缺失 | `role "x" does not exist`；`errors ignored on restore: 1` | PR-20 | manual | R |
| R-03 | 扩展不可用 | `extension "x" is not available` | PR-21 | manual | D |
| R-04 | `--clean` 目标对象不存在 | `table "x" does not exist`；`errors ignored on restore` | PR-22 | permanent | R |
| R-05 | 目标对象已存在 | SQLSTATE `42P07`，`already exists` | PR-22 | permanent | D |
| R-06 | 并行恢复死锁 | SQLSTATE `40P01`，`deadlock detected` | PR-23 | transient | D |
| R-07 | 编码或排序规则不兼容 | `invalid byte sequence` / collation mismatch | PR-24 | manual | D |
| R-08 | 大对象 OID 冲突 | `duplicate key value violates unique constraint` | PR-22 | permanent | D |
| R-09 | 目标为只读或备库 | `cannot execute ... in a read-only transaction` | PR-25 | permanent | D |
| R-10 | 恢复期间磁盘耗尽 | `No space left on device` | PR-06 | manual | D |
| R-11 | 序列未推进 | 恢复成功但 `nextval` 冲突（静默） | VERIFY-V3 | manual | D |
| R-12 | RLS 或事件触发器阻止恢复 | `new row violates row-level security` / trigger error | PR-26 | manual | D |

## 5. P — 时间点恢复

| ID | 触发条件 | 可观测签名 | 预检 | 分类 | 复现 |
|---|---|---|---|---|---|
| P-01 | WAL 不足，未达目标 | `FATAL: recovery ended before configured recovery target was reached` | PR-27 | manual | R |
| P-02 | 目标早于一致恢复点 | `FATAL: requested recovery stop point is before consistent recovery point` | PR-28 | manual | R |
| P-03 | WAL 段缺口 | `could not open file ... No such file or directory` | PR-29 | manual | D |
| P-04 | 跨时间线缺 `.history` | `could not find timeline history file` | PR-30 | manual | D |
| P-05 | `restore_command` 失败 | `restore_command failed` / permission denied | PR-31 | manual | D |
| P-06 | 多个恢复目标参数 | `multiple recovery targets specified` | PR-32 | permanent | D |
| P-07 | `recovery_target_action` 误配 | 非预期 promote / shutdown / pause | PR-33 | manual | D |
| P-08 | 备库 promote 失败 | `cannot promote` / `recovery is not in progress` | PR-34 | manual | D |

## 6. V — 校验

| ID | 触发条件 | 可观测签名 | 预检 | 分类 | 复现 |
|---|---|---|---|---|---|
| V-01 | 备份文件被篡改 | `has size N on disk but size M in the manifest` / checksum mismatch | PR-35 | manual | R |
| V-02 | 清单中的文件缺失 | `"X" is present in the manifest but not on disk` | PR-35 | manual | R |
| V-03 | 备份清单损坏 | `could not parse backup manifest` | PR-35 | manual | D |
| V-04 | WAL 未包含在备份中 | `WAL ... not found` | PR-36 | manual | D |
| V-05 | 行数比对假阴性 | 分区/继承表计数偏差 | VERIFY-V2 | manual | D |
| V-06 | 序列值未校验 | 恢复后 `nextval` 冲突 | VERIFY-V3 | manual | D |
| V-07 | 扩展版本不一致 | `extversion` 差异 | VERIFY-V2 | manual | D |
| V-08 | 校验环境指纹漂移 | 证据失效判定 | PR-37 | manual | D |

## 7. A — Agent 层

| ID | 触发条件 | 可观测签名 | 预检 | 分类 | 复现 |
|---|---|---|---|---|---|
| A-01 | argv 含 Shell 元字符 | SCHEMA 校验拒绝 `;|&$` 等 | Plan 校验 | permanent | R（单测） |
| A-02 | 计划指纹过期 | `fingerprint.expiresAt must be in the future` | Plan 校验 | manual | R（单测） |
| A-03 | 目标身份变化未重基 | `identity-mismatch` → abort | Plan 重基 | manual | D |
| A-04 | 模型臆造参数 | Schema 校验失败 | Plan 校验 | permanent | D |
| A-05 | 注入文本进入决策路径 | 信任等级违规 | 信任分层 | manual | D |
| A-06 | 审批绕过（风险越权） | `risk exceeds the Mandate allowance` | PERMISSION | manual | D |
| A-07 | 非零退出被误判为成功 | 执行器退出码契约失败 | C-03 契约 | permanent | D |
| A-08 | 幂等键重复导致重复副作用 | Outbox 去重命中 | 幂等键 | manual | D |
| A-09 | 目标拆解越界（步数超限、序号重复、依赖指向更晚的步骤） | `validateDecomposition` 返回 `DecompositionIssue` | 拆解校验 | permanent | R（单测） |
| A-10 | 动作超出 capability grammar（`--yes` / `--db` / `--principal` / 未声明 flag / 带口令的 `--dsn`） | `validateStepAction` 返回 `ActionIssue` | 动作校验 | permanent | R（单测） |
| A-11 | 未审批的破坏性步骤 | 签名 `approval:required`，候选集只有 `escalate` | 目标审批 | manual | R（单测 + 集成） |
| A-12 | 运行中断后步骤仍停在 `running` | 签名 `stalled`，候选 `replan` / `escalate` | 启动恢复 | permanent | R（单测） |
| A-13 | 修复动作越出封闭集或破坏性未开启 | `decideRemediation` 返回 `{ok:false, reason}` | 修复校验 | permanent | R（单测） |

## 8. 已复现条目详情

| ID | 根因 | 检测与处置 | 回滚 | 测试 |
|---|---|---|---|---|
| E-01 | 凭据错误 | 预检 `SELECT 1`；提示重新注入 `secretRef`，不重试 | 无副作用 | 证据 E-01 |
| E-02 | 角色缺失或凭据错误（不可区分） | 预检失败即拒绝；要求人工确认主体 | 无副作用 | 证据 E-02 |
| E-03 | 目标库不存在 | 预检 `pg_database`；拒绝并提示可用库列表 | 无副作用 | 证据 E-03 |
| S-01 | 目标库不存在 | 同 E-03；在计划阶段拒绝 | 无副作用 | 证据 S-01 |
| S-02 | 备份角色缺少表权限 | 预检权限矩阵；建议授予 `pg_read_all_data` 或按表授权 | 删除部分产物 | 证据 S-02 |
| S-03 | 持锁冲突 | 预检锁等待与长事务；失败按 transient 重试并退避 | 删除部分产物 | 证据 S-03 |
| R-01 | 客户端工具版本低于转储格式 | 预检工具版本矩阵；拒绝并提示升级 pg_restore | 删除目标库（若新建） | 证据 R-01 |
| R-02 | 转储中的属主角色不存在 | 预检角色清单；提供 `--no-owner` 或角色映射 | 删除目标库（若新建） | 证据 R-02 |
| R-04 | `--clean` 对空目标执行 | 预检目标对象；默认禁用 `--clean`，需显式授权 | 删除目标库（若新建） | 证据 R-04 |
| V-01 | 备份文件大小/校验和不符 | V0 校验失败即标记产物不可用 | 不进入保留链 | 证据 V-01 |
| V-02 | 清单文件缺失 | V0 校验失败即标记产物不可用 | 不进入保留链 | 证据 V-02 |
| P-01 | 归档 WAL 不足 | 预检可恢复窗口；拒绝窗口外目标 | 删除恢复实例目录 | 证据 P-01 |
| P-02 | 目标早于一致恢复点 | 预检目标下界（`stopLSN`） | 删除恢复实例目录 | 证据 P-02 |
| A-01 | argv 混入 Shell 语法 | 计划校验拒绝；执行器不解析 Shell | 无副作用 | 单测 |
| A-02 | 计划过期 | 执行前指纹复核；重新生成计划 | 无副作用 | 单测 |

## 9. 错误分类映射

| 签名 | 分类 | 重试策略 |
|---|---|---|
| 超时、`57014`、`55P03`、`08006`、`53300`、连接重置 | transient | 指数退避，最多 `maxAttempts` |
| 认证失败、`42501`、`EACCES`/`EPERM`、属主缺失、扩展缺失 | manual | 不重试，转人工 |
| `supported version` 不匹配、`42P01`/`42P07`/`42710`、Shell 元字符 | permanent | 不重试，需修正计划 |
| PITR 目标不可达、目标早于一致点、WAL 缺口 | manual | 不重试，需人工确认目标 |
| `pg_verifybackup` 摘要/文件缺失 | manual | 不重试，产物标记不可用 |
| 磁盘/inode 耗尽 | manual | 不自动重试，清理后重建计划 |
| `approval:required`（目标步骤未审批） | manual | 不重试，转人工；候选集只有 `escalate` |
| `stalled`（运行中断后仍停在 `running`） | permanent | 不派发；候选 `replan` / `escalate` |
| `usage:invalid-action`（动作越出 capability grammar） | permanent | 修正动作后 replan |

实现位置：`packages/core/src/executor/classify.ts`；新增签名须同步补充单测。

该文件同时提供两个供目标闭环使用的函数：

- `failureSignature(result)` 返回**稳定签名**（`auth:password`、`sqlstate:42P01`、`connect:refused`…），作为 `step_attempts.signature` 与长期记忆的键，因此改动签名等于改动记忆格式。
- `classifyStepFailure(result)` 为失败的一步定类：stderr 命中目录签名时以目录为准，只有 stderr 无可识别签名时才按 CLI 退出码推断（`3` 连接失败、`2` 用法、`4` plan 被拒）。这样 `password authentication failed` 不会因为退出码是 3 而被误判为可重试。

`goal run` 优先采用内层命令 JSON 信封里的 `result.errorClass` 与该步真实 stderr；只有信封不可解析时才退回 `classifyStepFailure`。理由是内层命令把步骤级 stderr 写在 stdout 的 JSON 里，外层 stderr 只有进度行。

## 10. 预检规则清单

| 规则 | 断言 | 关联条目 |
|---|---|---|
| PR-01 | 以目标主体执行 `SELECT 1` 成功 | E-01, E-02 |
| PR-02 | 目标库存在于 `pg_database` | E-03, S-01 |
| PR-03 | `pg_hba` 允许当前来源（连接失败信息判别） | E-04 |
| PR-04 | 备份角色具备 `REPLICATION` 或超级用户 | E-05 |
| PR-05 | 凭据文件权限为 0600 | E-06 |
| PR-06 | 目标与暂存空间 ≥ 预估值 × 1.2 | E-07, R-10 |
| PR-07 | `ulimit -n` ≥ 并发文件数 × 2 | E-08 |
| PR-08 | 连接余量 ≥ 2 | E-09 |
| PR-09 | 控制面与目标时钟偏移 ≤ 5s | E-10 |
| PR-10 | SSH 主机密钥与 `known_hosts` 一致 | E-11 |
| PR-11 | 备份角色对目标对象具备读取权限 | S-02 |
| PR-12 | 锁等待预算与长事务检查通过 | S-03 |
| PR-13 | 客户端工具版本与服务器版本兼容 | S-04, R-01 |
| PR-14 | 备份期间无阻塞性 DDL | S-05 |
| PR-15 | 无超过阈值的活动事务 | S-06 |
| PR-16 | 复制槽水位未阻塞回收 | S-07 |
| PR-17 | `archive_mode=on` 且 `failed_count` 未增长 | S-08 |
| PR-18 | tablespace 路径存在且可读 | S-09 |
| PR-19 | 网络连通性与超时预算满足 | S-10 |
| PR-20 | 转储中引用的角色在目标存在 | R-02 |
| PR-21 | 所需扩展在目标可用 | R-03 |
| PR-22 | 目标对象状态与策略一致（`--clean`/覆盖） | R-04, R-05, R-08 |
| PR-23 | 并行度不超过目标 CPU 与锁预算 | R-06 |
| PR-24 | 源与目标编码、collation 兼容 | R-07 |
| PR-25 | 目标非只读、非备库 | R-09 |
| PR-26 | RLS 与事件触发器策略允许恢复 | R-12 |
| PR-27 | 目标时间/LSN 位于 `[stopLSN, lastArchivedLSN]` | P-01 |
| PR-28 | 目标不早于一致恢复点 | P-02 |
| PR-29 | WAL 段区间无缺口 | P-03 |
| PR-30 | 跨时间线时 `.history` 存在 | P-04 |
| PR-31 | `restore_command` 可执行且路径可达 | P-05 |
| PR-32 | 恢复目标参数互斥 | P-06 |
| PR-33 | `recovery_target_action` 与策略一致 | P-07 |
| PR-34 | promote 前恢复状态与角色满足 | P-08 |
| PR-35 | `pg_verifybackup` 通过 | V-01, V-02, V-03 |
| PR-36 | 备份包含所需 WAL | V-04 |
| PR-37 | 校验环境指纹与证据一致 | V-08 |

## 11. 测试夹具与故障注入

| 夹具 | 用途 |
|---|---|
| `pg_hba` 拒绝、错误凭据 | E-01–E-04 |
| 只读角色、受限表权限 | S-02 |
| 持锁会话 + `lock_timeout` | S-03 |
| PG 17 转储 + PG 16 `pg_restore` | R-01 |
| 属主角色删除后的转储 | R-02 |
| `--clean` 对空目标 | R-04 |
| 篡改/删除备份文件 | V-01, V-02 |
| 缺段 WAL 归档 + 未来目标 | P-01 |
| 低于一致点的 LSN 目标 | P-02 |
| Shell 元字符 argv、过期指纹 | A-01, A-02 |

## 12. P1 准入核对

| 条件 | 结果 |
|---|---|
| 条目 ≥40 | 57 |
| 覆盖六个系列 | E/S/R/P/V/A |
| 复现 ≥15 | 15（13 容器 + 2 单测；另有 V-00 基线） |
| 条目映射预检或分类 | 100% |
| `destructive` 条目具备回滚路径 | 已逐条填写 |
| 评审冻结 | 待评审 |

## 13. 来源与可信度

| 等级 | 来源 | 用途 |
|---|---|---|
| 一级 | PostgreSQL 官方文档：Backup and Restore、Continuous Archiving、PITR、`pg_dump`、`pg_restore`、`pg_basebackup`、`pg_verifybackup`；各主版本 Release Notes | 行为契约与版本差异 |
| 一级 | pgBackRest User Guide、WAL-G README | provider 语义（文献级条目） |
| 二级 | 本地复现证据（2026-11-11） | 签名、退出码、处置验证 |
| 二级 | 本地 SHIELD `plugin/postgres` 实现 | 命令构造与错误处理对照 |

provider 专属条目（pgBackRest stanza/cipher、WAL-G retention）当前为文献级，P3 前须补充复现。

## 14. 未覆盖

- 云存储最终一致性、对象锁行为（无法本地复现）。
- 跨大版本升级（`pg_upgrade`）与逻辑复制切换。
- Oracle/MySQL 等异构引擎，待对应 adapter 建立后另立目录。

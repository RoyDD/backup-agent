---
name: pg-restore
description: 规划并执行 PostgreSQL 逻辑恢复，处理目标库、属主、扩展与 --clean 风险。
whenToUse: 用户要求恢复备份、回答“能不能恢复”、或需要把备份还原到新库/新实例时。
---

# PostgreSQL 恢复

## 预检

1. `pg_inspect` 确认目标实例版本、角色、磁盘余量与现有数据库。
2. 确认产物格式（custom/directory/plain）与转储版本；`pg_restore` 版本不得低于转储格式版本。
3. 确认目标库是否已存在；默认恢复到新库，禁止在生产主库就地覆盖。

## 恢复策略

| 场景 | 做法 |
|---|---|
| 新库验证 | `pg_restore --create-database`，目标名带时间戳 |
| 覆盖测试库 | `--clean --if-exists`，必须先获得审批 |
| 跨版本 | 目标版本不低于源版本；否则先升级或使用逻辑迁移 |
| 属主不存在 | 使用 `--no-owner`，或先创建角色映射 |

## 风险

- `--clean` 会删除目标库中同名对象，属破坏性操作；`pg_restore` 工具会拒绝未经审批的调用。
- 恢复后必须校验：Schema、行数、约束、序列；调用 `pg_verify` 获得证据。
- 恢复失败时不要反复重试同一计划；先读取 stderr 与失败分类（transient/permanent/manual）。

## 输出要求

- 目标库、恢复的产物、退出码、错误分类、校验结论。
- 若恢复到新实例，给出连接方式与后续 promote/切换建议。

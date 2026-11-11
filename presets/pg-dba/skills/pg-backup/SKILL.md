---
name: pg-backup
description: 选择并执行 PostgreSQL 备份策略（逻辑、物理、pgBackRest、WAL-G），并给出 RPO/RTO 取舍。
whenToUse: 用户要求备份、制定备份策略、选择备份工具，或询问全量/增量/差异备份时。
---

# PostgreSQL 备份选型

## 决策顺序

1. 先调用 `pg_inspect`，确认版本、`wal_level`、`archive_mode`、是否备库、磁盘与数据库清单。
2. 明确目标：单库/整实例、可接受的 RPO/RTO、是否要求 PITR、产物存放位置。
3. 按下列条件选型，再调用 `pg_backup`。

| 条件 | 选型 |
|---|---|
| 单库、跨版本迁移、数据量小 | 逻辑备份：`format=custom`，需要并行时用 `directory` |
| 整实例、要求 PITR | 物理备份：`mode=physical`，并确保 WAL 归档已配置 |
| 已有 pgBackRest 仓库与 stanza | `pgbackrest-backup`（全量/差异/增量） |
| 已有 WAL-G 仓库 | `walg-backup` |
| 只需 schema 或单表 | 逻辑备份 + `--table` / `--schema`（CLI） |

## 硬约束

- `--jobs` 仅适用于 `directory` 格式。
- 逻辑备份不保证 PITR；需要时间点恢复时必须使用物理备份 + WAL 归档。
- 不修改生产实例的 `archive_mode` / `archive_command`；发现未配置时报告并建议。
- 备份成功不等于可恢复：备份后调用 `pg_verify`（或至少 V0 完整性校验）。

## 输出要求

- 产物路径、格式、大小、耗时、目标实例指纹（`system_identifier`）。
- 对应的 RPO/RTO 结论，以及下一步校验建议。

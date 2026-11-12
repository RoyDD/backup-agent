---
name: pg-pitr
description: 规划 PostgreSQL 时间点恢复（PITR），校验 WAL 连续性与恢复目标边界。
whenToUse: 用户要求恢复到某个时间/LSN、询问可恢复窗口，或需要从误删/误更新中恢复时。
---

# PostgreSQL 时间点恢复

## 可恢复窗口

```
recoverableWindow = [backup.stopLSN, lastArchivedLSN] ∩ retentionWindow
```

- 目标时间必须晚于基础备份的 `stopLSN`。
- 目标必须早于最后一段已归档 WAL；否则恢复会以
  `recovery ended before configured recovery target was reached` 失败。
- 跨时间线时必须存在 `*.history`；缺失则拒绝恢复。

## 执行顺序

1. `pg_inspect` 确认 `archive_mode=on`、`archive_command` 非空、`pg_stat_archiver.failed_count` 未增长。
2. 确认基础备份目录与 `restore_command`（`cp` 或 `wal-g wal-fetch %f %p`）。
3. 调用 `bkagent pitr`（或 `pgbackrest-restore --target-type time`）：
   - 写入恢复 GUC 与 `recovery.signal`；
   - 以 `recovery_target_action = pause` 启动实例，断言已暂停在目标点（LSN/时间附额外证据）；
   - 按 `--action` 显式执行 `pg_ctl promote`、保持暂停或 `pg_ctl stop`；
   - 执行业务校验 SQL。
4. 校验通过后再切换流量。目标未达成或任一步失败时，计划的 cleanup 会停止**本次启动的**实例（`pg_ctl stop -m fast`，以 `.bkagent-pitr-started` 标记为前置条件），数据目录与日志保留用于取证；修正参数后可直接重跑。若 CLI 报告 `cleanup did not complete`，先手工停止实例再重试。

## 禁止

- 不在生产主库就地恢复。
- 不手工删除 `pg_wal` 或归档目录。
- 不猜测恢复目标；无法确定时先列出可恢复窗口并让用户选择。

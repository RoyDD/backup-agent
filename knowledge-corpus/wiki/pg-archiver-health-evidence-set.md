---
source_id: wiki-pg-archiver-health
title: 归档健康与 PITR 窗口断裂的证据集（wiki 摘要）
url: llm-wiki://postgresql-backup-recovery/wiki/concepts/pg-archiver-health-evidence-set.md
kind: md
origin: wiki
version: wiki-2026-11-12
license: internal
---

# 归档健康与 PITR 窗口断裂的证据集

`pg_stat_archiver` 是一行累计计数器，回答的是「归档进程做了什么」，不是「窗口是否完整」。

- `failed_count` 增长不等于窗口断裂：至少有一次尝试失败，之后可能重试成功。
- `failed_count` 不变不等于正常：也可能没有新段产生，或 archiver 未运行。
- `last_archived_wal` 前进不等于之前都已归档。PG 16 手册 §28.2.12 原文：
  「Normally, WAL files are archived in order, oldest to newest, but that is not guaranteed, and does not hold under special circumstances like when promoting a standby or after crash recovery. Therefore it is not safe to assume that all files older than `last_archived_wal` have also been successfully archived.」
- `stats_reset` 很近时，计数器不可用，改用待归档队列与仓库事实判定。

## 四组证据

1. 累计计数器：`archived_count` / `last_archived_wal` / `last_archived_time` / `failed_count` / `last_failed_wal` / `last_failed_time` / `stats_reset`；两次采样求差才有信息。
2. 待归档队列：`pg_wal/archive_status` 的 `.ready` 数量就是归档滞后段数，用 `pg_ls_archive_statusdir()` 读（默认需 superuser 或 `pg_monitor`）。
3. 归档 GUC：备库上 `archive_mode` 必须 `always`；`wal_level` 需 `replica`/`logical`；低写入集群没有 `archive_timeout` 会让 PITR 粒度被未满段拖住。
4. 仓库侧事实：`pgbackrest info`、`wal-g wal-verify`、对象清单；PG 侧证明契约被履行，仓库侧证明对象可用，缺一不可。

## 三条查询

```sql
SELECT archived_count, last_archived_wal, last_archived_time,
       failed_count, last_failed_wal, last_failed_time, stats_reset,
       now() - last_archived_time AS since_last_archive,
       now() - last_failed_time AS since_last_failure
FROM pg_stat_archiver;

SELECT count(*) FILTER (WHERE name LIKE '%.ready') AS ready_segments,
       count(*) FILTER (WHERE name LIKE '%.done') AS done_markers
FROM pg_ls_archive_statusdir();

SELECT pg_size_pretty(
         pg_wal_lsn_diff(
           pg_current_wal_flush_lsn(),
           '0/0'::pg_lsn
             + (SELECT segment_number FROM pg_split_walfile_name(a.last_archived_wal))
               * current_setting('wal_segment_size')::bigint
         )
       ) AS archived_lag
FROM pg_stat_archiver a;
```

## 四象限判定（60 秒两次采样）

| `last_archived_wal` 前进 | `failed_count` 增长 | 结论 |
|---|---|---|
| 是 | 是 | 间歇失败、重试成功；窗口仍在推进，查 `last_failed_wal` |
| 否 | 是 | 窗口已断裂，RPO 从 `last_archived_time` 起累积；恢复预检须以 `lastArchivedLSN` 为上界 |
| 否 | 否 | 无新段产生或 archiver 未运行；先看 `ready_segments` 与 `archive_mode` / `wal_level` |
| 是 | 否 | 正常 |

## 反模式

只对 `failed_count` 告警；把 `last_failed_wal` 当未归档起点；用 `last_archived_wal` 推断连续性；
忽略 `archive_timeout`；备库 `archive_mode=on`；只看 PG 侧或只看仓库侧。

## 与恢复预检的接口

PITR 窗口 = `[backup.stopLSN, lastArchivedLSN] ∩ retentionWindow`。目标晚于 `lastArchivedLSN` 必须拒绝；
段缺口只能用待归档队列或仓库清单证明；跨时间线缺 `.history` 必须拒绝。

## 工具侧

`archive_command` 退出码非 0 记一次失败；pgBackRest `archive-push` 开启 `archive-async` 后，
PG 侧成功只代表入队，落地要看 provider 日志与 `pgbackrest info`；WAL-G `wal-push` 同理，
`wal-verify`（integrity / timeline）是仓库侧第二证据。

> 本文是 llm-wiki 条目的摘要视图，完整版与证据分级见原条目。

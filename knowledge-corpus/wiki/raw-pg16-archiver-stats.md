---
source_id: wikiraw-pg16-archiver-stats
title: 摘录：pg_stat_archiver、archive_status 与归档 GUC（PG16 官方手册）
url: llm-wiki://postgresql-backup-recovery/raw/articles/pg16-archiver-stats-evidence-excerpt.md
kind: md
origin: wiki
tier: evidence
version: pg16-wiki-raw-2026-11-12
license: internal
---

# pg_stat_archiver 与归档证据（PG16 官方手册摘录）

证据等级 A。来源 PostgreSQL 16 官方手册 §28.2.12 / §9.27.9 / §20.5.3。

## pg_stat_archiver（§28.2.12）

单行视图，描述 archiver 进程。列定义（原文）：

| 列 | 类型 | 原文 |
|---|---|---|
| archived_count | bigint | Number of WAL files that have been successfully archived |
| last_archived_wal | text | Name of the WAL file most recently successfully archived |
| last_archived_time | timestamptz | Time of the most recent successful archive operation |
| failed_count | bigint | Number of failed attempts for archiving WAL files |
| last_failed_wal | text | Name of the WAL file of the most recent failed archival operation |
| last_failed_time | timestamptz | Time of the most recent failed archival operation |
| stats_reset | timestamptz | Time at which these statistics were last reset |

原文警告，决定所有推论边界：

> Normally, WAL files are archived in order, oldest to newest, but that is not guaranteed,
> and does not hold under special circumstances like when promoting a standby or after crash
> recovery. Therefore it is not safe to assume that all files older than last_archived_wal
> have also been successfully archived.

## pg_ls_archive_statusdir()（§9.27.9）

> pg_ls_archive_statusdir () → setof record (name text, size bigint, modification timestamptz)
> Returns the name, size, and last modification time (mtime) of each ordinary file in the
> server's WAL archive status directory (pg_wal/archive_status).
> This function is restricted to superusers and members of the pg_monitor role by default,
> but other users can be granted EXECUTE to run the function.

## 归档 GUC（§20.5.3）

- archive_mode：off / on / always；备库上归档必须 always。
- archive_command：每个待归档段执行一次；退出码 0 才视为成功，非零记一次失败并重试。
- archive_timeout：强制段切换上限；低写入集群不设它，PITR 时间粒度被最后一个未满段拖住。

## 相关函数（§9.27.3）

pg_walfile_name(lsn)（LSN 恰在段边界时返回前一个段）、pg_walfile_name_offset(lsn)、
pg_split_walfile_name(name)、pg_wal_lsn_diff(a, b)。

## 未在 16 手册本章出现的细节（B 级）

pg_wal/archive_status 下 .ready / .done 后缀语义未被 continuous-archiving 章节直接描述，
引用该目录时以 pg_ls_archive_statusdir() 的官方签名为准，后缀语义标 B。

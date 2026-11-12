---
source_id: wikiraw-pg16-wal-naming
title: 摘录：WAL 段命名、LSN 换算与边界行为（PG16 官方手册）
url: llm-wiki://postgresql-backup-recovery/raw/articles/pg16-wal-naming-evidence-excerpt.md
kind: md
origin: wiki
tier: evidence
version: pg16-wiki-raw-2026-11-12
license: internal
---

# WAL 段命名与 LSN 换算（PG16 官方手册摘录）

证据等级 A。来源 PostgreSQL 16 手册 WAL Internals / §9.27.3 / §26.3.5。

## 段文件与默认大小（WAL Internals）

> ... segment files, normally each 16 MB in size (but the size can be changed by altering
> the --wal-segsize initdb option)

> Segment files are given ever-increasing numbers as names, starting at
> 000000010000000000000001

## 五个换算函数（§9.27.3）

| 函数 | 返回 | 说明 |
|---|---|---|
| pg_walfile_name(lsn) | text | LSN → WAL 文件名 |
| pg_walfile_name_offset(lsn) | (file_name, file_offset) | 文件名 + 段内偏移 |
| pg_split_walfile_name(file_name) | (segment_number numeric, timeline_id bigint) | 段名 → 段号与时间线 |
| pg_wal_lsn_diff(lsn1, lsn2) | numeric | 字节差 |
| pg_current_wal_flush_lsn() | pg_lsn | 已落盘位置 |

## 边界行为（原文）

> When the given write-ahead log location is exactly at a write-ahead log file boundary,
> both these functions return the name of the preceding write-ahead log file. This is
> usually the desired behavior for managing write-ahead log archiving behavior, since the
> preceding file is the last one that currently needs to be archived.

## 手册的段号换算示例

```
postgres=# \set file_name '000000010000000100C000AB'
postgres=# \set offset 256
postgres=# SELECT '0/0'::pg_lsn + pd.segment_number * ps.setting::int + :offset AS lsn
  FROM pg_split_walfile_name(:'file_name') pd,
       pg_show_all_settings() ps
  WHERE ps.name = 'wal_segment_size';
      lsn
---------------
 C001/AB000100
```

## PITR 目标下界（§26.3.5 原文）

> The stop point must be after the ending time of the base backup, i.e., the end time of
> pg_backup_stop. You cannot use a base backup to recover to a time when that backup was in
> progress. (To recover to such a time, you must go back to your previous base backup and
> roll forward from there.)

## 未逐字描述的部分（B 级）

文件名 24 个十六进制字符按 timeline / logid / segno 各 8 位等宽分段：手册未逐字这样写，
但由 pg_split_walfile_name 的返回值与上面的换算示例可反推。

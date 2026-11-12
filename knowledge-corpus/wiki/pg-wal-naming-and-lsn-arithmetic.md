---
source_id: wiki-pg-wal-naming
title: WAL 段命名与 LSN 换算速查（wiki 摘要）
url: llm-wiki://postgresql-backup-recovery/wiki/references/pg-wal-naming-and-lsn-arithmetic.md
kind: md
origin: wiki
version: wiki-2026-11-12
license: internal
---

# WAL 段命名与 LSN 换算速查

WAL 段文件 `000000010000000000000001` 是 `timeline(8) + logid(8) + segno(8)` 的十六进制；
段号从 1 起递增；默认段大小 16 MB，由 `initdb --wal-segsize` 固定，运行期由 `wal_segment_size` 反映。

## 五个换算函数（PG 16 手册 §9.27.3）

| 函数 | 作用 | 关键行为 |
|---|---|---|
| `pg_walfile_name(lsn)` | LSN → 段文件名 | LSN 恰在段边界时返回**前一个**段 |
| `pg_walfile_name_offset(lsn)` | LSN → (文件名, 段内偏移) | 同上 |
| `pg_split_walfile_name(name)` | 段名 → (segment_number, timeline_id) | 反向换算入口 |
| `pg_wal_lsn_diff(a, b)` | 字节差 | 算 lag 的唯一可靠方式 |
| `pg_current_wal_flush_lsn()` | 已落盘位置 | 归档/复制算 lag 用它，别用 insert LSN |

边界行为是官方明说的：「When the given write-ahead log location is exactly at a write-ahead log file
boundary, both these functions return the name of the preceding write-ahead log file. This is usually
the desired behavior for managing write-ahead log archiving behavior, since the preceding file is the
last one that currently needs to be archived.」因此不要因为边界那次指向旧段就认为新段缺失。

## 三条换算查询

```sql
-- LSN → 段名与段内偏移
SELECT * FROM pg_walfile_name_offset(pg_current_wal_flush_lsn());

-- 段名 → 段起始 LSN（手册示例用法）
SELECT '0/0'::pg_lsn
       + (SELECT segment_number FROM pg_split_walfile_name('00000001000000000000000D'))
         * current_setting('wal_segment_size')::bigint AS segment_start_lsn;

-- 归档滞后字节数
SELECT pg_size_pretty(
         pg_wal_lsn_diff(
           pg_current_wal_flush_lsn(),
           '0/0'::pg_lsn
             + (SELECT segment_number FROM pg_split_walfile_name(last_archived_wal))
               * current_setting('wal_segment_size')::bigint
         )
       ) AS archived_lag
FROM pg_stat_archiver;
```

`segment_number` 只是段序号，不含 logid；跨过 `0x100000000` 个段才进位，工具里别当完整 64 位偏移。

## 时间线与 .history

文件名前 8 位是 timeline；提升后新主写入新 timeline 的段。跨时间线恢复必须能找到 `.history`，
否则 recovery 无法接续，这类缺口只能在仓库侧取证。**不要跨时间线做段名字符串比较**；
同时间线内等宽十六进制比较安全，但仍受上面的边界行为影响。

## PITR 目标下界

手册 §26.3.5：「The stop point must be after the ending time of the base backup, i.e., the end time of
`pg_backup_stop`. You cannot use a base backup to recover to a time when that backup was in progress.」
可恢复窗口 `[backup.stopLSN, lastArchivedLSN]` 的端点都是 LSN，用户输入是时间或段名时先换算再比。

## 六个常见错误

把段号当 LSN；忽略边界返回前一个文件；用 `pg_current_wal_lsn()` 而非 flush LSN 算 lag；
跨时间线比较段名；硬编码 16 MB；用段名记录 `stopLSN`。

> 本文是 llm-wiki 条目的摘要视图，完整版与证据分级见原条目。

---
source_id: pg16-backup
title: PostgreSQL: Documentation: 16: Chapter 26. Backup and Restore
url: https://www.postgresql.org/docs/16/backup.html
kind: html
version: pg16
license: PostgreSQL License
fetched_at: 2026-11-11
sha256: 129a267e71a33bae17b3df867f41927865e5e052bc9537ae353f25eadc0d9321
chars: 3021
---
October 15, 2026: [PostgreSQL 19 RC 1 Released!](/about/news/postgresql-19-rc-1-released-3409/)

[Documentation](/docs/ "Documentation") → [PostgreSQL 16](/docs/16/index.html)

Supported Versions: [Current](/docs/current/backup.html "PostgreSQL 18 - Chapter 26. Backup and Restore") ([18](/docs/18/backup.html "PostgreSQL 18 - Chapter 26. Backup and Restore")) / [17](/docs/17/backup.html "PostgreSQL 17 - Chapter 26. Backup and Restore") / [16](/docs/16/backup.html "PostgreSQL 16 - Chapter 26. Backup and Restore") / [15](/docs/15/backup.html "PostgreSQL 15 - Chapter 26. Backup and Restore") / [14](/docs/14/backup.html "PostgreSQL 14 - Chapter 26. Backup and Restore")

Development Versions: [19](/docs/19/backup.html "PostgreSQL 19 - Chapter 26. Backup and Restore") / [devel](/docs/devel/backup.html "PostgreSQL devel - Chapter 26. Backup and Restore")

Unsupported versions: [13](/docs/13/backup.html "PostgreSQL 13 - Chapter 26. Backup and Restore") / [12](/docs/12/backup.html "PostgreSQL 12 - Chapter 26. Backup and Restore") / [11](/docs/11/backup.html "PostgreSQL 11 - Chapter 26. Backup and Restore") / [10](/docs/10/backup.html "PostgreSQL 10 - Chapter 26. Backup and Restore") / [9.6](/docs/9.6/backup.html "PostgreSQL 9.6 - Chapter 26. Backup and Restore") / [9.5](/docs/9.5/backup.html "PostgreSQL 9.5 - Chapter 26. Backup and Restore") / [9.4](/docs/9.4/backup.html "PostgreSQL 9.4 - Chapter 26. Backup and Restore") / [9.3](/docs/9.3/backup.html "PostgreSQL 9.3 - Chapter 26. Backup and Restore") / [9.2](/docs/9.2/backup.html "PostgreSQL 9.2 - Chapter 26. Backup and Restore") / [9.1](/docs/9.1/backup.html "PostgreSQL 9.1 - Chapter 26. Backup and Restore") / [9.0](/docs/9.0/backup.html "PostgreSQL 9.0 - Chapter 26. Backup and Restore") / [8.4](/docs/8.4/backup.html "PostgreSQL 8.4 - Chapter 26. Backup and Restore") / [8.3](/docs/8.3/backup.html "PostgreSQL 8.3 - Chapter 26. Backup and Restore") / [8.2](/docs/8.2/backup.html "PostgreSQL 8.2 - Chapter 26. Backup and Restore") / [8.1](/docs/8.1/backup.html "PostgreSQL 8.1 - Chapter 26. Backup and Restore") / [8.0](/docs/8.0/backup.html "PostgreSQL 8.0 - Chapter 26. Backup and Restore") / [7.4](/docs/7.4/backup.html "PostgreSQL 7.4 - Chapter 26. Backup and Restore") / [7.3](/docs/7.3/backup.html "PostgreSQL 7.3 - Chapter 26. Backup and Restore") / [7.2](/docs/7.2/backup.html "PostgreSQL 7.2 - Chapter 26. Backup and Restore") / [7.1](/docs/7.1/backup.html "PostgreSQL 7.1 - Chapter 26. Backup and Restore")

## Chapter 26. Backup and Restore

As with everything that contains valuable data, PostgreSQL databases should be backed up regularly. While the procedure is essentially simple, it is important to have a clear understanding of the underlying techniques and assumptions.

There are three fundamentally different approaches to backing up PostgreSQL data:

-   SQL dump
    
-   File system level backup
    
-   Continuous archiving
    

Each has its own strengths and weaknesses; each is discussed in turn in the following sections.

---
source_id: pgbr-command
title: pgBackRest - Command Reference
url: https://pgbackrest.org/command.html
kind: html
version: pgbackrest-2.x
license: MIT
fetched_at: 2026-11-11
sha256: d4e06e98a5d71ef5c7764b29006c601efb529db522caf0eddbac7613703d4021
chars: 201165
---
## General Options

General Options

### Config (--config)

Config (--config)

pgBackRest configuration file.

Use this option to specify a different configuration file than the default.

```
default: CFGOPTDEF_CONFIG_PATH "/" PROJECT_CONFIG_FILE
example: --config=/conf/pgbackrest/pgbackrest.conf
```

### Config Include Path (--config-include-path)

Config Include Path (--config-include-path)

Path to additional pgBackRest configuration files.

Configuration files existing in the specified location with extension .conf will be concatenated with the pgBackRest configuration file, resulting in one configuration file.

```
default: CFGOPTDEF_CONFIG_PATH "/" PROJECT_CONFIG_INCLUDE_PATH
example: --config-include-path=/conf/pgbackrest/conf.d
```

### Config Path (--config-path)

Config Path (--config-path)

Base path of pgBackRest configuration files.

This setting is used to override the default base path setting for the --config and --config-include-path options unless they are explicitly set on the command-line.

For example, passing only --config-path=/conf/pgbackrest results in the --config default being set to /conf/pgbackrest/pgbackrest.conf and the --config-include-path default being set to /conf/pgbackrest/conf.d.

```
default: CFGOPTDEF_CONFIG_PATH
example: --config-path=/conf/pgbackrest
```

### Dry Run (--dry-run)

Dry Run (--dry-run)

Execute a dry-run for the command.

The --dry-run option is a command-line only option and can be passed when it is desirable to determine what modifications will be made by the command without the command actually making any modifications.

```
default: n
example: --dry-run
```

### Raw Data (--raw)

Raw Data (--raw)

Do not transform data.

Do not transform (i.e, encrypt, decompress, etc.) data for the current command.

```
default: n
example: --raw
```

### Set Repository (--repo)

Set Repository (--repo)

Set repository.

Set the repository for a command to operate on.

For example, this option may be used to perform a restore from a specific repository, rather than letting pgBackRest choose.

```
allowed: [1, 256]
example: --repo=1
```

### Stanza (--stanza)

Stanza (--stanza)

Defines the stanza.

A stanza is the configuration for a PostgreSQL database cluster that defines where it is located, how it will be backed up, archiving options, etc. Most db servers will only have one PostgreSQL database cluster and therefore one stanza, whereas backup servers will have a stanza for every database cluster that needs to be backed up.

It is tempting to name the stanza after the primary cluster but a better name describes the databases contained in the cluster. Because the stanza name will be used for the primary and all replicas it is more appropriate to choose a name that describes the actual function of the cluster, such as app or dw, rather than the local cluster name, such as main or prod.

```
example: --stanza=main
```

## Annotate Backup (annotate)

Annotate Backup (annotate)

Annotations included with the backup command can be added, modified, or removed afterwards using the annotate command.

### Command Options

Command Options

#### Backup Annotation (--annotation)

Backup Annotation (--annotation)

Annotate backup with user-defined key/value pairs.

Users can attach informative key/value pairs to the backup. This option may be used multiple times to attach multiple annotations.

Annotations are output by the info command text output when a backup is specified with --set and always appear in the JSON output.

```
example: --annotation=source="Sunday backup for website database"
```

#### Set (--set)

Set (--set)

Backup set to annotate.

The backup set to annotate.

```
example: --set=20150131-153358F_20150131-153401I
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

## Archive Get (archive-get)

Archive Get (archive-get)

This command is used by PostgreSQL to restore a backup, perform PITR, or as an alternative to streaming for keeping a replica up to date. WAL segments are required for PostgreSQL recovery or to maintain a replica.

When multiple repositories are configured, WAL will be fetched from the repositories in priority order (e.g. repo1, repo2, etc.). In general it is better if faster/cheaper storage has higher priority. If a repository is specified with the --repo option then only that repository will be searched.

The archive-get command is configured and generated by pgBackRest during a restore for use by PostgreSQL. See [Point-in-Time Recovery](user-guide.html#pitr) for an example.

### Command Options

Command Options

#### Asynchronous Archiving (--archive-async)

Asynchronous Archiving (--archive-async)

Push/get WAL segments asynchronously.

Enables asynchronous operation for the archive-push and archive-get commands.

Asynchronous operation is more efficient because it can reuse connections and take advantage of parallelism. See the spool-path, archive-get-queue-max, and archive-push-queue-max options for more information.

```
default: n
example: --archive-async
```

#### Maximum Archive Get Queue Size (--archive-get-queue-max)

Maximum Archive Get Queue Size (--archive-get-queue-max)

Maximum size of the pgBackRest archive-get queue.

Specifies the maximum size of the archive-get queue when archive-async is enabled. The queue is stored in the spool-path and is used to speed providing WAL to PostgreSQL.

```
default: 128MiB
allowed: [0B, 4PiB]
example: --archive-get-queue-max=1GiB
```

#### Retry Missing WAL Segment (--archive-missing-retry)

Retry Missing WAL Segment (--archive-missing-retry)

Retry missing WAL segment

Retry a WAL segment that was previously reported as missing by the archive-get command when in asynchronous mode. This prevents notifications in the spool path from a prior restore from being used and possibly causing a recovery failure if consistency has not been reached.

Disabling this option allows PostgreSQL to more reliably recognize when the end of the WAL in the archive has been reached, which permits it to switch over to streaming from the primary. With retries enabled, a steady stream of WAL being archived will cause PostgreSQL to continue getting WAL from the archive rather than switch to streaming.

When disabling this option it is important to ensure that the spool path for the stanza is empty. The restore command does this automatically if the spool path is configured at restore time. Otherwise, it is up to the user to ensure the spool path is empty.

```
default: y
example: --no-archive-missing-retry
```

#### Archive Timeout (--archive-timeout)

Archive Timeout (--archive-timeout)

Archive timeout.

Set maximum time, in seconds, to wait for each WAL segment to reach the pgBackRest archive repository. The timeout applies to the check and backup commands when waiting for WAL segments required for backup consistency to be archived.

```
default: 1m
allowed: [100ms, 1d]
example: --archive-timeout=30
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [pgBackRest Command (--cmd)](configuration.html#section-general/option-cmd)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Process Maximum (--process-max)](configuration.html#section-general/option-process-max)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Spool Path (--spool-path)](configuration.html#section-general/option-spool-path)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Target Time for Repository (--repo-target-time)](configuration.html#section-repository/option-repo-target-time)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)

## Archive Push (archive-push)

Archive Push (archive-push)

Accepts a WAL segment from PostgreSQL and archives it in each repository defined by the indexed repo-path option (see the [Repository](configuration.html#section-repository) section for information on configuring repositories). The WAL segment may be pushed immediately to the archive or stored locally depending on the value of archive-async. With multiple repositories configured, archive-push will attempt to push to as many repositories as possible.

The archive-push is intended to be configured and called by PostgreSQL. See [Configure Archiving](user-guide.html#quickstart/configure-archiving) for an example.

### Command Options

Command Options

#### Asynchronous Archiving (--archive-async)

Asynchronous Archiving (--archive-async)

Push/get WAL segments asynchronously.

Enables asynchronous operation for the archive-push and archive-get commands.

Asynchronous operation is more efficient because it can reuse connections and take advantage of parallelism. See the spool-path, archive-get-queue-max, and archive-push-queue-max options for more information.

```
default: n
example: --archive-async
```

#### Check Archive (--archive-check)

Check Archive (--archive-check)

Check that WAL segments are in the archive before backup completes.

Checks that all WAL segments required to make the backup consistent are present in the WAL archive. It's a good idea to leave this as the default unless you are using another method for archiving.

This option must be enabled if archive-copy is enabled.

```
default: y
example: --no-archive-check
```

#### Check Archive Mode (--archive-mode-check)

Check Archive Mode (--archive-mode-check)

Check the PostgreSQL archive_mode setting.

Enabled by default, this option disallows PostgreSQL archive_mode=always.

WAL segments pushed from a standby server might be logically the same as WAL segments pushed from the primary but have different checksums. Disabling archiving from multiple sources is recommended to avoid conflicts.

CAUTION:

If this option is disabled then it is critical to ensure that only one archiver is writing to the repository via the archive-push command.

```
default: y
example: --no-archive-mode-check
```

#### Archive Push Batch Size (--archive-push-batch-size)

Archive Push Batch Size (--archive-push-batch-size)

Maximum amount of WAL to push per asynchronous run.

In asynchronous mode the archive-push process pushes all the WAL segments that are ready in a single run. Since archive-push-queue-max is only checked at the start of each run, a run that processes a very large number of segments can let the queue grow well beyond the limit before it is rechecked.

This option limits the amount of WAL processed per run so the process exits and is spawned again by the next archive-push, which rechecks the queue. Lower values recheck the queue more often at the cost of spawning the asynchronous process more frequently. The value is rounded down to a whole number of WAL segments but at least one segment is always processed.

```
default: 16GiB
allowed: [1MiB, 4PiB]
example: --archive-push-batch-size=1GiB
```

#### Maximum Archive Push Queue Size (--archive-push-queue-max)

Maximum Archive Push Queue Size (--archive-push-queue-max)

Maximum size of the PostgreSQL archive queue.

After the limit is reached, the following will happen:

-   pgBackRest will notify PostgreSQL that the WAL was successfully archived, then **DROP IT**.
-   A warning will be output to the PostgreSQL log.

If this occurs then the archive log stream will be interrupted and PITR will not be possible past that point. A new backup will be required to regain full restore capability.

In asynchronous mode the entire queue will be dropped to prevent spurts of WAL getting through before the queue limit is exceeded again.

In asynchronous mode this limit is only checked at the start of each archive-push run, so the queue can grow beyond it within a single run. Reduce archive-push-batch-size to check the queue more frequently.

The purpose of this feature is to prevent the log volume from filling up at which point PostgreSQL will stop completely. Better to lose the backup than have PostgreSQL go down.

```
allowed: [0B, 4PiB]
example: --archive-push-queue-max=1TiB
```

Deprecated Name: archive-queue-max

#### Archive Timeout (--archive-timeout)

Archive Timeout (--archive-timeout)

Archive timeout.

Set maximum time, in seconds, to wait for each WAL segment to reach the pgBackRest archive repository. The timeout applies to the check and backup commands when waiting for WAL segments required for backup consistency to be archived.

```
default: 1m
allowed: [100ms, 1d]
example: --archive-timeout=30
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [pgBackRest Command (--cmd)](configuration.html#section-general/option-cmd)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Compress (--compress)](configuration.html#section-general/option-compress)
-   [Compress Level (--compress-level)](configuration.html#section-general/option-compress-level)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Compress Type (--compress-type)](configuration.html#section-general/option-compress-type)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Process Maximum (--process-max)](configuration.html#section-general/option-process-max)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Spool Path (--spool-path)](configuration.html#section-general/option-spool-path)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [WAL Header Check (--archive-header-check)](configuration.html#section-maintainer/option-archive-header-check)
-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)

## Backup (backup)

Backup (backup)

When multiple repositories are configured, pgBackRest will backup to the highest priority repository (e.g. repo1) unless the --repo option is specified.

pgBackRest does not have a built-in scheduler so it's best to run it from cron or some other scheduling mechanism.

See [Perform a Backup](user-guide.html#quickstart/perform-backup) for more details and examples.

### Command Options

Command Options

#### Backup Annotation (--annotation)

Backup Annotation (--annotation)

Annotate backup with user-defined key/value pairs.

Users can attach informative key/value pairs to the backup. This option may be used multiple times to attach multiple annotations.

Annotations are output by the info command text output when a backup is specified with --set and always appear in the JSON output.

```
example: --annotation=source="Sunday backup for website database"
```

#### Check Archive (--archive-check)

Check Archive (--archive-check)

Check that WAL segments are in the archive before backup completes.

Checks that all WAL segments required to make the backup consistent are present in the WAL archive. It's a good idea to leave this as the default unless you are using another method for archiving.

This option must be enabled if archive-copy is enabled.

```
default: y
example: --no-archive-check
```

#### Copy Archive (--archive-copy)

Copy Archive (--archive-copy)

Copy WAL segments needed for consistency to the backup.

This slightly paranoid option protects against corruption in the WAL segment archive by storing the WAL segments required for consistency directly in the backup. WAL segments are still stored in the archive so this option will use additional space.

It is best if the archive-push and backup commands have the same compress-type (e.g. lz4) when using this option. Otherwise, the WAL segments will need to be recompressed with the compress-type used by the backup, which can be fairly expensive depending on how much WAL was generated during the backup.

On restore, the WAL segments will be present in pg_xlog/pg_wal and PostgreSQL will use them in preference to calling the restore_command.

The archive-check option must be enabled if archive-copy is enabled.

```
default: n
example: --archive-copy
```

#### Check Archive Mode (--archive-mode-check)

Check Archive Mode (--archive-mode-check)

Check the PostgreSQL archive_mode setting.

Enabled by default, this option disallows PostgreSQL archive_mode=always.

WAL segments pushed from a standby server might be logically the same as WAL segments pushed from the primary but have different checksums. Disabling archiving from multiple sources is recommended to avoid conflicts.

CAUTION:

If this option is disabled then it is critical to ensure that only one archiver is writing to the repository via the archive-push command.

```
default: y
example: --no-archive-mode-check
```

#### Archive Timeout (--archive-timeout)

Archive Timeout (--archive-timeout)

Archive timeout.

Set maximum time, in seconds, to wait for each WAL segment to reach the pgBackRest archive repository. The timeout applies to the check and backup commands when waiting for WAL segments required for backup consistency to be archived.

```
default: 1m
allowed: [100ms, 1d]
example: --archive-timeout=30
```

#### Backup from Standby (--backup-standby)

Backup from Standby (--backup-standby)

Backup from the standby cluster.

Enable backup from standby to reduce load on the primary cluster. This option requires that both the primary and standby hosts be configured.

The following modes are supported:

-   y - Standby is required for backup.
-   prefer - Backup from standby if available otherwise backup from primary.
-   n - Backup from primary only.

```
default: n
example: --backup-standby=y
```

#### Page Checksums (--checksum-page)

Page Checksums (--checksum-page)

Validate data page checksums.

Directs pgBackRest to validate all data page checksums while backing up a cluster. This option is automatically enabled when data page checksums are enabled on the cluster.

Failures in checksum validation will not abort a backup. Rather, warnings will be emitted in the log (and to the console with default settings) and the list of invalid pages will be stored in the backup manifest.

```
example: --no-checksum-page
```

#### Error on Invalid Page Checksums (--checksum-page-error)

Error on Invalid Page Checksums (--checksum-page-error)

Error on invalid page checksums.

When enabled with the checksum-page option, a failure in page checksum validation will terminate the backup.

```
default: n
example: --no-checksum-page-error
```

#### Path/File Exclusions (--exclude)

Path/File Exclusions (--exclude)

Exclude paths/files from the backup.

All exclusions are relative to $PGDATA. If the exclusion ends with / then only files in the specified directory will be excluded, e.g. --exclude=junk/ will exclude all files in the $PGDATA/junk directory but include the directory itself. If the exclusion does not end with / then the file may match the exclusion exactly or match with / appended to the exclusion, e.g. --exclude=junk will exclude the $PGDATA/junk directory and all the files it contains.

**Be careful using this feature -- it is very easy to exclude something critical that will make the backup inconsistent. Be sure to test your restores!**

All excluded files will be logged at info level along with the exclusion rule. Be sure to audit the list of excluded files to ensure nothing unexpected is being excluded.

NOTE:

Exclusions are not honored on delta restores. Any files/directories that were excluded by the backup will be _removed_ on delta restore.

This option should not be used to exclude PostgreSQL logs from a backup. Logs can be moved out of the PGDATA directory using the PostgreSQL log_directory setting, which has the benefit of allowing logs to be preserved after a restore.

Multiple exclusions may be specified on the command-line or in a configuration file.

```
example: --exclude=junk/
```

#### Expire Auto (--expire-auto)

Expire Auto (--expire-auto)

Automatically run the expire command after a successful backup.

The setting is enabled by default. Use caution when disabling this option as doing so will result in retaining all backups and archives indefinitely, which could cause your repository to run out of space. The expire command will need to be run regularly to prevent this from happening.

When expire is run automatically after a successful backup it uses the configuration of the backup command, so options set only in an expire command section (e.g. [global:expire]) are not applied. To apply expire-specific configuration, disable this option and run the expire command separately.

```
default: y
example: --expire-auto
```

#### Force (--force)

Force (--force)

Force an offline backup.

When used with --no-start-stop a backup will be run even if pgBackRest thinks that PostgreSQL is running. **This option should be used with extreme care as it will likely result in a bad backup.**

There are some scenarios where a backup might still be desirable under these conditions. For example, if a server crashes and the database cluster volume can only be mounted read-only, it would be a good idea to take a backup even if postmaster.pid is present. In this case it would be better to revert to the prior backup and replay WAL, but possibly there is a very important transaction in a WAL segment that did not get archived.

```
default: n
example: --force
```

#### Manifest Save Threshold (--manifest-save-threshold)

Manifest Save Threshold (--manifest-save-threshold)

Manifest save threshold during backup.

Defines how often the manifest will be saved during a backup. Saving the manifest is important because it stores the checksums and allows the resume function to work efficiently. The actual threshold used is 1% of the backup size or manifest-save-threshold, whichever is greater.

```
default: 1GiB
allowed: [1B, 1TiB]
example: --manifest-save-threshold=8GiB
```

#### Online (--online)

Online (--online)

Perform an online backup.

Specifying --no-online prevents pgBackRest from running the backup start/stop functions on the database cluster. In order for this to work PostgreSQL should be shut down and pgBackRest will generate an error if it is not.

The purpose of this option is to allow offline backups. The pg_xlog/pg_wal directory is copied as-is and archive-check is automatically disabled for the backup.

```
default: y
example: --no-online
```

#### Resume (--resume)

Resume (--resume)

Allow resume of failed backup.

Defines whether the resume feature is enabled. Resume can greatly reduce the amount of time required to run a backup after a previous backup of the same type has failed. It adds complexity, however, so it may be desirable to disable in environments that do not require the feature.

```
default: y
example: --no-resume
```

#### Start Fast (--start-fast)

Start Fast (--start-fast)

Force a checkpoint to start backup quickly.

Forces a checkpoint (by passing y to the fast parameter of the backup start function) so the backup begins immediately. Otherwise the backup will start after the next regular checkpoint.

```
default: n
example: --start-fast
```

#### Type (--type)

Type (--type)

Backup type.

The following backup types are supported:

-   full - all database cluster files will be copied and there will be no dependencies on previous backups.
-   incr - incremental from the last successful backup.
-   diff - like an incremental backup but always based on the last full backup.

```
default: incr
example: --type=full
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [pgBackRest Command (--cmd)](configuration.html#section-general/option-cmd)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Compress (--compress)](configuration.html#section-general/option-compress)
-   [Compress Level (--compress-level)](configuration.html#section-general/option-compress-level)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Compress Type (--compress-type)](configuration.html#section-general/option-compress-type)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Database Timeout (--db-timeout)](configuration.html#section-general/option-db-timeout)
-   [Delta (--delta)](configuration.html#section-general/option-delta)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Process Maximum (--process-max)](configuration.html#section-general/option-process-max)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Page Header Check (--page-header-check)](configuration.html#section-maintainer/option-page-header-check)
-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Block Incremental Backup (--repo-block)](configuration.html#section-repository/option-repo-block)
-   [Repository Bundles (--repo-bundle)](configuration.html#section-repository/option-repo-bundle)
-   [Repository Bundle Limit (--repo-bundle-limit)](configuration.html#section-repository/option-repo-bundle-limit)
-   [Repository Bundle Size (--repo-bundle-size)](configuration.html#section-repository/option-repo-bundle-size)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Hardlink (--repo-hardlink)](configuration.html#section-repository/option-repo-hardlink)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [Archive Retention (--repo-retention-archive)](configuration.html#section-repository/option-repo-retention-archive)
-   [Archive Retention Type (--repo-retention-archive-type)](configuration.html#section-repository/option-repo-retention-archive-type)
-   [Differential Retention (--repo-retention-diff)](configuration.html#section-repository/option-repo-retention-diff)
-   [Full Retention (--repo-retention-full)](configuration.html#section-repository/option-repo-retention-full)
-   [Full Retention Type (--repo-retention-full-type)](configuration.html#section-repository/option-repo-retention-full-type)
-   [Backup History Retention (--repo-retention-history)](configuration.html#section-repository/option-repo-retention-history)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Symlink (--repo-symlink)](configuration.html#section-repository/option-repo-symlink)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Database (--pg-database)](configuration.html#section-stanza/option-pg-database)
-   [PostgreSQL Host (--pg-host)](configuration.html#section-stanza/option-pg-host)
-   [PostgreSQL Host Certificate Authority File (--pg-host-ca-file)](configuration.html#section-stanza/option-pg-host-ca-file)
-   [PostgreSQL Host Certificate Authority Path (--pg-host-ca-path)](configuration.html#section-stanza/option-pg-host-ca-path)
-   [PostgreSQL Host Certificate File (--pg-host-cert-file)](configuration.html#section-stanza/option-pg-host-cert-file)
-   [PostgreSQL Host Command (--pg-host-cmd)](configuration.html#section-stanza/option-pg-host-cmd)
-   [PostgreSQL Host Configuration (--pg-host-config)](configuration.html#section-stanza/option-pg-host-config)
-   [PostgreSQL Host Configuration Include Path (--pg-host-config-include-path)](configuration.html#section-stanza/option-pg-host-config-include-path)
-   [PostgreSQL Host Configuration Path (--pg-host-config-path)](configuration.html#section-stanza/option-pg-host-config-path)
-   [PostgreSQL Host Key File (--pg-host-key-file)](configuration.html#section-stanza/option-pg-host-key-file)
-   [PostgreSQL Host Port (--pg-host-port)](configuration.html#section-stanza/option-pg-host-port)
-   [PostgreSQL Host Protocol Type (--pg-host-type)](configuration.html#section-stanza/option-pg-host-type)
-   [PostgreSQL Host User (--pg-host-user)](configuration.html#section-stanza/option-pg-host-user)
-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)
-   [PostgreSQL Port (--pg-port)](configuration.html#section-stanza/option-pg-port)
-   [PostgreSQL Socket Path (--pg-socket-path)](configuration.html#section-stanza/option-pg-socket-path)
-   [PostgreSQL Database User (--pg-user)](configuration.html#section-stanza/option-pg-user)

## Check Configuration (check)

Check Configuration (check)

The check command validates that pgBackRest and the archive_command setting are configured correctly for archiving and backups for the specified stanza. It will attempt to check all repositories and databases that are configured for the host on which the command is run. It detects misconfigurations, particularly in archiving, that result in incomplete backups because required WAL segments did not reach the archive. The command can be run on the PostgreSQL or repository host. The command may also be run on the standby host, however, since pg_switch_xlog()/pg_switch_wal() cannot be performed on the standby, the command will only test the repository configuration.

Note that pg_create_restore_point('pgBackRest Archive Check') and pg_switch_xlog()/pg_switch_wal() are called to force PostgreSQL to archive a WAL segment.

### Command Options

Command Options

#### Check Archive (--archive-check)

Check Archive (--archive-check)

Check that WAL segments are in the archive before backup completes.

Checks that all WAL segments required to make the backup consistent are present in the WAL archive. It's a good idea to leave this as the default unless you are using another method for archiving.

This option must be enabled if archive-copy is enabled.

```
default: y
example: --no-archive-check
```

#### Check Archive Mode (--archive-mode-check)

Check Archive Mode (--archive-mode-check)

Check the PostgreSQL archive_mode setting.

Enabled by default, this option disallows PostgreSQL archive_mode=always.

WAL segments pushed from a standby server might be logically the same as WAL segments pushed from the primary but have different checksums. Disabling archiving from multiple sources is recommended to avoid conflicts.

CAUTION:

If this option is disabled then it is critical to ensure that only one archiver is writing to the repository via the archive-push command.

```
default: y
example: --no-archive-mode-check
```

#### Archive Timeout (--archive-timeout)

Archive Timeout (--archive-timeout)

Archive timeout.

Set maximum time, in seconds, to wait for each WAL segment to reach the pgBackRest archive repository. The timeout applies to the check and backup commands when waiting for WAL segments required for backup consistency to be archived.

```
default: 1m
allowed: [100ms, 1d]
example: --archive-timeout=30
```

#### Backup from Standby (--backup-standby)

Backup from Standby (--backup-standby)

Backup from the standby cluster.

Enable backup from standby to reduce load on the primary cluster. This option requires that both the primary and standby hosts be configured.

The following modes are supported:

-   y - Standby is required for backup.
-   prefer - Backup from standby if available otherwise backup from primary.
-   n - Backup from primary only.

```
default: n
example: --backup-standby=y
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Database Timeout (--db-timeout)](configuration.html#section-general/option-db-timeout)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Database (--pg-database)](configuration.html#section-stanza/option-pg-database)
-   [PostgreSQL Host (--pg-host)](configuration.html#section-stanza/option-pg-host)
-   [PostgreSQL Host Certificate Authority File (--pg-host-ca-file)](configuration.html#section-stanza/option-pg-host-ca-file)
-   [PostgreSQL Host Certificate Authority Path (--pg-host-ca-path)](configuration.html#section-stanza/option-pg-host-ca-path)
-   [PostgreSQL Host Certificate File (--pg-host-cert-file)](configuration.html#section-stanza/option-pg-host-cert-file)
-   [PostgreSQL Host Command (--pg-host-cmd)](configuration.html#section-stanza/option-pg-host-cmd)
-   [PostgreSQL Host Configuration (--pg-host-config)](configuration.html#section-stanza/option-pg-host-config)
-   [PostgreSQL Host Configuration Include Path (--pg-host-config-include-path)](configuration.html#section-stanza/option-pg-host-config-include-path)
-   [PostgreSQL Host Configuration Path (--pg-host-config-path)](configuration.html#section-stanza/option-pg-host-config-path)
-   [PostgreSQL Host Key File (--pg-host-key-file)](configuration.html#section-stanza/option-pg-host-key-file)
-   [PostgreSQL Host Port (--pg-host-port)](configuration.html#section-stanza/option-pg-host-port)
-   [PostgreSQL Host Protocol Type (--pg-host-type)](configuration.html#section-stanza/option-pg-host-type)
-   [PostgreSQL Host User (--pg-host-user)](configuration.html#section-stanza/option-pg-host-user)
-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)
-   [PostgreSQL Port (--pg-port)](configuration.html#section-stanza/option-pg-port)
-   [PostgreSQL Socket Path (--pg-socket-path)](configuration.html#section-stanza/option-pg-socket-path)
-   [PostgreSQL Database User (--pg-user)](configuration.html#section-stanza/option-pg-user)

## Expire Backups (expire)

Expire Backups (expire)

pgBackRest does full backup rotation based on the retention type which can be a count or a time period. When a count is specified, then expiration is not concerned with when the backups were created but with how many must be retained. Differential backups are count-based but will always be expired when the full backup they depend on is expired. Incremental backups are not expired by retention independently — they are always expired with their related full or differential backup. See sections [Full Backup Retention](user-guide.html#retention/full) and [Differential Backup Retention](user-guide.html#retention/diff) for details and examples.

Archived WAL is retained by default for backups that have not expired, however, although not recommended, this schedule can be modified per repository with the retention-archive options. See section [Archive Retention](user-guide.html#retention/archive) for details and examples.

The expire command is run automatically after each successful backup and can also be run by the user. When run by the user, expiration will occur as defined by the retention settings for each configured repository. If the --repo option is provided, expiration will occur only on the specified repository. Expiration can also be limited by the user to a specific backup set with the --set option and, unless the --repo option is specified, all repositories will be searched and any matching the set criteria will be expired. It should be noted that the archive retention schedule will be checked and performed any time the expire command is run.

### Command Options

Command Options

#### Expire Archive Before (--archive-expire-before)

Expire Archive Before (--archive-expire-before)

Remove WAL archive earlier than the specified WAL segment.

Remove WAL segments earlier than the specified segment, but only those that are not required by a retained backup, that is, segments older than the earliest backup set to retain, or any segment when the repository contains no backup. The specified segment and everything after it are kept. This mirrors the value passed by PostgreSQL to archive_cleanup_command as %r.

This option is primarily intended for archive-only repositories where no backups are stored. It can also be used to reclaim WAL archive space before the first backup when full retention has not yet been met to trigger archive expiration.

```
example: --archive-expire-before=000000010000000000000010
```

#### Error on Invalid Page Checksums (--checksum-page-error)

Error on Invalid Page Checksums (--checksum-page-error)

Error on invalid page checksums.

If enabled, the expire command will terminate with an error before any changes if the oldest retained backup would contain checksum errors. If this option is disabled, the expire will proceed and issue a warning if there are checksum errors in the oldest retained backup.

If the --set is used, the expire will proceed even if this option is enabled. It will emit a warning if the oldest retained backup contains checksum errors.

```
default: y
example: --no-checksum-page-error
```

#### Oldest (--oldest)

Oldest (--oldest)

Expire the oldest eligible backup set.

Expire the oldest full backup set that can be removed (meaning at least one newer full backup remains). This is equivalent to manually decrementing retention by one, but computed automatically. All backups related to the expired full backup set (differential and incremental) are also expired.

When used, archive retention is also temporarily adjusted so WAL for the expired backups can be removed in the same run.

If time-based full retention is configured (using --repo-retention-full-type=time) then --oldest uses count-based expiration for this execution.

WARNING:

This option cannot be combined with --set.

```
default: n
example: --oldest
```

#### Set (--set)

Set (--set)

Backup set to expire.

The specified backup set (i.e. the backup label provided and all of its dependent backups, if any) will be expired regardless of backup retention rules except that at least one full backup must remain in the repository.

WARNING:

Use this option with extreme caution — it will permanently remove all backups and archives not required to make a backup consistent from the pgBackRest repository for the specified backup set. This process may negate the ability to perform PITR. If --repo-retention-full and/or --repo-retention-archive options are configured, then it is recommended that you override these options by setting their values to the maximum while performing ad hoc expiration in order to prevent an unintended expiration of archives.

```
example: --set=20150131-153358F_20150131-153401I
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Dry Run (--dry-run)](#section-general/option-dry-run)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [Archive Retention (--repo-retention-archive)](configuration.html#section-repository/option-repo-retention-archive)
-   [Archive Retention Type (--repo-retention-archive-type)](configuration.html#section-repository/option-repo-retention-archive-type)
-   [Differential Retention (--repo-retention-diff)](configuration.html#section-repository/option-repo-retention-diff)
-   [Full Retention (--repo-retention-full)](configuration.html#section-repository/option-repo-retention-full)
-   [Full Retention Type (--repo-retention-full-type)](configuration.html#section-repository/option-repo-retention-full-type)
-   [Backup History Retention (--repo-retention-history)](configuration.html#section-repository/option-repo-retention-history)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Symlink (--repo-symlink)](configuration.html#section-repository/option-repo-symlink)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

## Help (help)

Help (help)

Three levels of help are provided. If no command is specified then general help will be displayed. If a command is specified (e.g. pgbackrest help backup) then a full description of the command will be displayed along with a list of valid options. If an option is specified in addition to a command (e.g. pgbackrest help backup type) then a full description of the option as it applies to the command will be displayed.

### Command Options

Command Options

#### Display Help (--help)

Display Help (--help)

Display help.

Displays help even if the help command is not specified and overrides the --version option.

```
default: n
example: --help
```

#### Display Version (--version)

Display Version (--version)

Display version.

Displays version even if the version or help command is not specified.

```
default: n
example: --version
```

## Repository Info (info)

Repository Info (info)

The info command operates on a single stanza or all stanzas. Text output is the default and gives a human-readable summary of backups for the stanza(s) requested. This format is subject to change with any release.

For machine-readable output use --output=json. The JSON output contains far more information than the text output and is kept stable unless a bug is found.

To speed up execution, limit the output to only progress information by specifying --detail-level=progress. Note that this skips all checks except for availability of the stanza.

Each stanza has a separate section and it is possible to limit output to a single stanza with the --stanza option. The stanza 'status' gives a brief indication of the stanza's health. If this is 'ok' then pgBackRest is functioning normally. If there are multiple repositories, then a status of 'mixed' indicates that the stanza is not in a healthy state on one or more of the repositories; in this case the state of the stanza will be detailed per repository. For cases in which an error on a repository occurred that is not one of the known error codes, then an error code of 'other' will be used and the full error details will be provided. The 'wal archive min/max' shows the minimum and maximum WAL currently stored in the archive and, in the case of multiple repositories, will be reported across all repositories unless the --repo option is set. Note that there may be gaps due to archive retention policies or other reasons.

The 'backup/expire running' and/or 'restore running' messages will appear beside the 'status' information if any of those commands are currently running on the host. Per-repo progress will be also reported in text output and a 'repo' array will be included in JSON output.

The backups are displayed oldest to newest. The oldest backup will _always_ be a full backup (indicated by an F at the end of the label) but the newest backup can be full, differential (ends with D), or incremental (ends with I).

The 'timestamp start/stop' defines the time period when the backup ran. The 'timestamp stop' can be used to determine the backup to use when performing Point-In-Time Recovery. More information about Point-In-Time Recovery can be found in the [Point-In-Time Recovery](user-guide.html#pitr) section.

The 'wal start/stop' defines the WAL range that is required to make the database consistent when restoring. The backup command will ensure that this WAL range is in the archive before completing.

The 'database size' is the full uncompressed size of the database while 'database backup size' is the amount of data in the database to actually back up (these will be the same for full backups).

The 'repo' indicates in which repository this backup resides. The 'backup set size' includes all the files from this backup and any referenced backups in the repository that are required to restore the database from this backup while 'backup size' includes only the files in this backup (these will also be the same for full backups). Repository sizes reflect compressed file sizes if compression is enabled in pgBackRest.

The 'backup reference total' summarizes the list of additional backups that are required to restore this backup. Use the --set option to display the complete reference list.

### Command Options

Command Options

#### Detail level (--detail-level)

Detail level (--detail-level)

Output detail level.

The following levels are supported:

-   progress - Output only the current backup/expire progress. This level cannot be used with the --set option.
-   full - Output full info.

```
default: full
example: --detail-level=progress
```

#### Output (--output)

Output (--output)

Output format.

The following output types are supported:

-   text - Human-readable summary of backup information.
-   json - Exhaustive machine-readable backup information in JSON format.

```
default: text
example: --output=json
```

#### Set (--set)

Set (--set)

Backup set to detail.

Details include a complete list of additional backups that are required to restore this backup, a list of databases (with OIDs) in the backup set (excluding template databases), tablespaces (with OIDs) with the destination where they will be restored by default, and symlinks with the destination where they will be restored when --link-all is specified.

```
example: --set=20150131-153358F_20150131-153401I
```

#### Type (--type)

Type (--type)

Filter on backup type.

The following backup types are supported:

-   full - Output only full backups.
-   diff - Output only differential backups.
-   incr - Output only incremental backups.

```
example: --type=full
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Target Time for Repository (--repo-target-time)](configuration.html#section-repository/option-repo-target-time)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

## Repository Get (repo-get)

Repository Get (repo-get)

Similar to the unix cat command but works on any supported repository type. This command requires a fully qualified file name and is primarily for administration, investigation, and testing. It is not a required part of a normal pgBackRest setup.

If the repository is encrypted then repo-get will automatically decrypt the file. Files are not automatically decompressed but the output can be piped through the appropriate decompression command, e.g. gzip -d.

If more than one repository is configured, the command will default to the highest priority repository (e.g. repo1) unless the --repo option is specified.

### Command Options

Command Options

#### Ignore Missing (--ignore-missing)

Ignore Missing (--ignore-missing)

Ignore missing source file.

Exit with 1 if the source file is missing but don't throw an error.

```
default: n
example: --ignore-missing
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Raw Data (--raw)](#section-general/option-raw)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Target Time for Repository (--repo-target-time)](configuration.html#section-repository/option-repo-target-time)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

## Repository List (repo-ls)

Repository List (repo-ls)

Similar to the unix ls command but works on any supported repository type. This command accepts a path, absolute or relative to the repository path defined by the --repo-path option, and is primarily for administration, investigation, and testing. It is not a required part of a normal pgBackRest setup.

The default text output prints one file name per line. JSON output is available by specifying --output=json.

If more than one repository is configured, the command will default to the highest priority repository (e.g. repo1) unless the --repo option is specified.

### Command Options

Command Options

#### Filter Output (--filter)

Filter Output (--filter)

Filter output with a regular expression.

The filter is applied against the file/path names before they are output.

```
example: --filter="(F|D|I)$"
```

#### Output (--output)

Output (--output)

Output format.

The following output types are supported:

-   text - Simple list with one file/link/path name on each line.
-   json - Detailed file/link/path information in JSON format.

In JSON format the available fields are:

-   name - file/link/path name (and partial path when recursing).
-   type - file, path, or link.
-   size - size in bytes (files only).
-   time - time last modified (files only).
-   destination - link destination (links only).

```
default: text
example: --output=json
```

#### Recurse Subpaths (--recurse)

Recurse Subpaths (--recurse)

Include all subpaths in output.

All subpaths and their files will be included in the output.

```
default: n
example: --recurse
```

#### Sort Output (--sort)

Sort Output (--sort)

Sort output ascending, descending, or none.

The following sort types are supported:

-   asc - sort ascending.
-   desc - sort descending.
-   none - no sorting.

```
default: asc
example: --sort=desc
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Target Time for Repository (--repo-target-time)](configuration.html#section-repository/option-repo-target-time)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

## Restore Backup (restore)

Restore Backup (restore)

The restore command automatically defaults to selecting the latest backup from the first repository where backups exist (see [Quick Start - Restore a Backup](user-guide.html#quickstart/perform-restore)). The order in which the repositories are checked is dictated by the pgbackrest.conf (e.g. repo1 will be checked before repo2). To select from a specific repository, the --repo option can be passed (e.g. --repo=1). The --set option can be passed if a backup other than the latest is desired.

When PITR of --type=time or --type=lsn is specified, then the target time or target lsn must be specified with the --target option. If a backup is not specified via the --set option, then the configured repositories will be checked, in order, for a backup that contains the requested time or lsn. If no matching backup is found, the latest backup from the first repository containing backups will be used for --type=time while no backup will be selected for --type=lsn. For other types of PITR, e.g. xid, the --set option must be provided if the target is prior to the latest backup. See [Point-in-Time Recovery](user-guide.html#pitr) for more details and examples.

Replication slots are not included per recommendation of PostgreSQL. See [Backing Up The Data Directory](https://www.postgresql.org/docs/current/continuous-archiving.html#BACKUP-LOWLEVEL-BASE-BACKUP-DATA) in the PostgreSQL documentation for more information.

### Command Options

Command Options

#### Archive Mode (--archive-mode)

Archive Mode (--archive-mode)

Preserve or disable archiving on restored cluster.

This option allows archiving to be preserved or disabled on a restored cluster. This is useful when the cluster must be promoted to do some work but is not intended to become the new primary. In this case it is not a good idea to push WAL from the cluster into the repository.

The following modes are supported:

-   off - disable archiving by setting archive_mode=off.
-   preserve - preserve current archive_mode setting.

**NOTE**: This option is not available on PostgreSQL < 12.

```
default: preserve
example: --archive-mode=off
```

#### Error on Invalid Page Checksums (--checksum-page-error)

Error on Invalid Page Checksums (--checksum-page-error)

Error on invalid page checksums.

If enabled, the restore command will terminate with an error if it encounters a file containing checksum errors.

A warning will be emitted for each file with checksum errors if the setting is disabled.

```
default: y
example: --no-checksum-page-error
```

#### Exclude Database (--db-exclude)

Exclude Database (--db-exclude)

Restore excluding the specified databases.

Databases excluded will be restored as sparse, zeroed files to save space but still allow PostgreSQL to perform recovery. After recovery, those databases will not be accessible but can be removed with the drop database command. The --db-exclude option can be passed multiple times to specify more than one database to exclude.

When used in combination with the --db-include option, --db-exclude will only apply to standard system databases (template0, template1, and postgres).

```
example: --db-exclude=db_main
```

#### Include Database (--db-include)

Include Database (--db-include)

Restore only specified databases.

This feature allows only selected databases to be restored. Databases not specifically included will be restored as sparse, zeroed files to save space but still allow PostgreSQL to perform recovery. After recovery, the databases that were not included will not be accessible but can be removed with the drop database command.

NOTE:

built-in databases (template0, template1, and postgres) are always restored unless specifically excluded.

The --db-include option can be passed multiple times to specify more than one database to include.

See [Restore Selected Databases](user-guide.html#restore/option-db-include) for additional information and caveats.

```
example: --db-include=db_main
```

#### Force (--force)

Force (--force)

Force a restore.

By itself this option forces the PostgreSQL data and tablespace paths to be completely overwritten. In combination with --delta a timestamp/size delta will be performed instead of using checksums.

```
default: n
example: --force
```

#### Link All (--link-all)

Link All (--link-all)

Restore all symlinks.

By default symlinked directories and files are restored as normal directories and files in $PGDATA. This is because it may not be safe to restore symlinks to their original destinations on a system other than where the original backup was performed. This option restores all the symlinks just as they were on the original system where the backup was performed.

```
default: n
example: --link-all
```

#### Link Map (--link-map)

Link Map (--link-map)

Modify the destination of a symlink.

Allows the destination file or path of a symlink to be changed on restore. This is useful for restoring to systems that have a different storage layout than the original system where the backup was generated.

```
example: --link-map=pg_xlog=/data/xlog
```

#### Recovery Option (--recovery-option)

Recovery Option (--recovery-option)

Set an option in postgresql.auto.conf or recovery.conf.

See [Server Configuration](https://www.postgresql.org/docs/current/runtime-config.html) for details on postgresql.auto.conf or recovery.conf options (be sure to select your PostgreSQL version). This option can be used multiple times.

For PostgreSQL >= 12, options will be written into postgresql.auto.conf. For all other versions, options will be written into recovery.conf.

NOTE:

The restore_command option will be automatically generated but can be overridden with this option. Be careful about specifying your own restore_command as pgBackRest is designed to handle this for you. Target Recovery options (recovery_target_name, recovery_target_time, etc.) are generated automatically by pgBackRest and should not be set with this option.

Since pgBackRest does not start PostgreSQL after writing the postgresql.auto.conf or recovery.conf file, it is always possible to edit/check postgresql.auto.conf or recovery.conf before manually restarting.

```
example: --recovery-option=primary_conninfo=db.mydomain.com
```

#### Set (--set)

Set (--set)

Backup set to restore.

The backup set to be restored. latest will restore the latest backup, otherwise provide the name of the backup to restore.

```
default: latest
example: --set=20150131-153358F_20150131-153401I
```

#### Tablespace Map (--tablespace-map)

Tablespace Map (--tablespace-map)

Restore a tablespace into the specified directory.

Moves a tablespace to a new location during the restore. This is useful when tablespace locations are not the same on a replica, or an upgraded system has different mount points.

Tablespace locations are not stored in pg_tablespace so moving tablespaces can be done with impunity. However, moving a tablespace to the data_directory is not recommended and may cause problems. For more information on moving tablespaces http://www.databasesoup.com/2013/11/moving-tablespaces.html is a good resource.

```
example: --tablespace-map=ts_01=/db/ts_01
```

#### Map All Tablespaces (--tablespace-map-all)

Map All Tablespaces (--tablespace-map-all)

Restore all tablespaces into the specified directory.

Tablespaces are restored into their original locations by default. This behavior can be modified for each tablespace with the tablespace-map option, but it is sometimes preferable to remap all tablespaces to a new directory all at once. This is particularly useful for development or staging systems that may not have the same storage layout as the original system where the backup was generated.

The path specified will be the parent path used to create all the tablespaces in the backup.

CAUTION:

Tablespaces created after the backup started will not be mapped. Make a new backup after a tablespace is created if tablespace mapping is required.

```
example: --tablespace-map-all=/data/tablespace
```

#### Target (--target)

Target (--target)

Recovery target.

Defines the recovery target when --type is lsn, name, xid, or time. If the target is prior to the latest backup and --type is not time or lsn, then use the --set option to specify the backup set.

```
example: --target=2015-01-30 14:15:11 EST
```

#### Target Action (--target-action)

Target Action (--target-action)

Action to take when recovery target is reached.

When hot_standby=on, the default since PostgreSQL 10, this option consistently controls what the cluster does when the target is reached or there is no more WAL in the archive.

When hot_standby=off in PostgreSQL >= 12, pause acts like shutdown. When hot_standby=off in PostgreSQL < 12, pause acts like promote.

The following actions are supported:

-   pause - pause when recovery target is reached.
-   promote - promote and switch timeline when recovery target is reached.
-   shutdown - shutdown server when recovery target is reached. (PostgreSQL >= 9.5)

```
default: pause
example: --target-action=promote
```

#### Target Exclusive (--target-exclusive)

Target Exclusive (--target-exclusive)

Stop just before the recovery target is reached.

Defines whether recovery to the target would be exclusive (the default is inclusive) and is only valid when --type is lsn, time or xid. For example, using --target-exclusive would exclude the contents of transaction 1007 when --type=xid and --target=1007. See the recovery_target_inclusive option in the PostgreSQL docs for more information.

```
default: n
example: --no-target-exclusive
```

#### Target Timeline (--target-timeline)

Target Timeline (--target-timeline)

Recover along a timeline.

See recovery_target_timeline in the PostgreSQL docs for more information.

```
example: --target-timeline=3
```

#### Type (--type)

Type (--type)

Recovery type.

The following recovery types are supported:

-   default - recover to the end of the archive stream.
-   immediate - recover only until the database becomes consistent.
-   lsn - recover to the LSN (Log Sequence Number) specified in --target. This option is only supported on PostgreSQL >= 10.
-   name - recover the restore point specified in --target.
-   xid - recover to the transaction id specified in --target.
-   time - recover to the time specified in --target.
-   preserve - preserve the existing postgresql.auto.conf or recovery.conf file.
-   standby - add standby_mode=on to the postgresql.auto.conf or recovery.conf file so cluster will start in standby mode.
-   none - no postgresql.auto.conf or recovery.conf file is written so PostgreSQL will attempt to achieve consistency using WAL segments present in pg_xlog/pg_wal. Provide the required WAL segments or use the archive-copy setting to include them with the backup.

WARNING:

Recovery type=none should be avoided because the timeline will not be incremented at the end of recovery. This can lead to, for example, PostgreSQL attempting to archive duplicate WAL, which will be rejected, and may cause the disk to fill up and result in a PostgreSQL panic. In addition, tools like pg_rewind may not work correctly or may cause corruption.

Note that the default restore type for offline backups is none since Point-in-Time-Recovery is not possible if wal_level=minimal. If type is set explicitly then it will be honored since Point-in-Time-Recovery is possible from offline backups as long as wal_level > minimal.

```
default: default
example: --type=xid
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [pgBackRest Command (--cmd)](configuration.html#section-general/option-cmd)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Delta (--delta)](configuration.html#section-general/option-delta)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Process Maximum (--process-max)](configuration.html#section-general/option-process-max)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Target Time for Repository (--repo-target-time)](configuration.html#section-repository/option-repo-target-time)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)

## TLS Server (server)

TLS Server (server)

The pgBackRest server allows access to remote hosts without using the SSH protocol.

### Command Options

Command Options

#### TLS Server Address (--tls-server-address)

TLS Server Address (--tls-server-address)

TLS server address.

IP address the server will listen on for client requests.

```
default: localhost
example: --tls-server-address=*
```

#### TLS Server Authorized Clients (--tls-server-auth)

TLS Server Authorized Clients (--tls-server-auth)

TLS server authorized clients.

Clients are authorized on the server by verifying their certificate and checking their certificate CN (Common Name) against a list on the server configured with the tls-server-auth option.

A client CN can be authorized for as many stanzas as needed by providing a comma-separated list to the tls-server-auth option or for all stanzas by specifying tls-server-auth=client-cn=*. Wildcards may not be specified for the client CN.

```
example: --tls-server-auth=client-cn=stanza1,stanza2
```

#### TLS Server Certificate Authorities (--tls-server-ca-file)

TLS Server Certificate Authorities (--tls-server-ca-file)

TLS server certificate authorities.

Checks that client certificates are signed by a trusted certificate authority.

```
example: --tls-server-ca-file=/path/to/server.ca
```

#### TLS Server Certificate (--tls-server-cert-file)

TLS Server Certificate (--tls-server-cert-file)

TLS server certificate file.

Sent to the client to show the server identity.

```
example: --tls-server-cert-file=/path/to/server.crt
```

#### TLS Server Key (--tls-server-key-file)

TLS Server Key (--tls-server-key-file)

TLS server key file.

Proves server certificate was sent by the owner.

```
example: --tls-server-key-file=/path/to/server.key
```

#### TLS Server Port (--tls-server-port)

TLS Server Port (--tls-server-port)

TLS server port.

Port the server will listen on for client requests.

```
default: 8432
allowed: [1, 65535]
example: --tls-server-port=8000
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

## TLS Server Ping (server-ping)

TLS Server Ping (server-ping)

Ping a pgBackRest TLS server to ensure it is accepting connections. This serves as an aliveness check only since no authentication is attempted.

If no host is specified on the command-line then the tls-server-host option will be used.

### Command Options

Command Options

#### TLS Server Address (--tls-server-address)

TLS Server Address (--tls-server-address)

TLS server address.

IP address the server will listen on for client requests.

```
default: localhost
example: --tls-server-address=*
```

#### TLS Server Port (--tls-server-port)

TLS Server Port (--tls-server-port)

TLS server port.

Port the server will listen on for client requests.

```
default: 8432
allowed: [1, 65535]
example: --tls-server-port=8000
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

## Stanza Create (stanza-create)

Stanza Create (stanza-create)

The stanza-create command must be run after the stanza has been configured in pgbackrest.conf. If there is more than one repository configured, the stanza will be created on each. Stanzas that have already been created will be skipped so it is always safe to run stanza-create, even when a new repository has been configured.

See [Create the Stanza](user-guide.html#quickstart/create-stanza) for more information and an example.

### Command Options

Command Options

#### Online (--online)

Online (--online)

Create on an online cluster.

Specifying --no-online prevents pgBackRest from connecting to PostgreSQL when creating the stanza.

```
default: y
example: --no-online
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Database Timeout (--db-timeout)](configuration.html#section-general/option-db-timeout)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Database (--pg-database)](configuration.html#section-stanza/option-pg-database)
-   [PostgreSQL Host (--pg-host)](configuration.html#section-stanza/option-pg-host)
-   [PostgreSQL Host Certificate Authority File (--pg-host-ca-file)](configuration.html#section-stanza/option-pg-host-ca-file)
-   [PostgreSQL Host Certificate Authority Path (--pg-host-ca-path)](configuration.html#section-stanza/option-pg-host-ca-path)
-   [PostgreSQL Host Certificate File (--pg-host-cert-file)](configuration.html#section-stanza/option-pg-host-cert-file)
-   [PostgreSQL Host Command (--pg-host-cmd)](configuration.html#section-stanza/option-pg-host-cmd)
-   [PostgreSQL Host Configuration (--pg-host-config)](configuration.html#section-stanza/option-pg-host-config)
-   [PostgreSQL Host Configuration Include Path (--pg-host-config-include-path)](configuration.html#section-stanza/option-pg-host-config-include-path)
-   [PostgreSQL Host Configuration Path (--pg-host-config-path)](configuration.html#section-stanza/option-pg-host-config-path)
-   [PostgreSQL Host Key File (--pg-host-key-file)](configuration.html#section-stanza/option-pg-host-key-file)
-   [PostgreSQL Host Port (--pg-host-port)](configuration.html#section-stanza/option-pg-host-port)
-   [PostgreSQL Host Protocol Type (--pg-host-type)](configuration.html#section-stanza/option-pg-host-type)
-   [PostgreSQL Host User (--pg-host-user)](configuration.html#section-stanza/option-pg-host-user)
-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)
-   [PostgreSQL Port (--pg-port)](configuration.html#section-stanza/option-pg-port)
-   [PostgreSQL Socket Path (--pg-socket-path)](configuration.html#section-stanza/option-pg-socket-path)
-   [PostgreSQL Database User (--pg-user)](configuration.html#section-stanza/option-pg-user)

## Stanza Delete (stanza-delete)

Stanza Delete (stanza-delete)

The stanza-delete command removes data in the repository associated with a stanza.

WARNING:

Use this command with caution — it will permanently remove all backups and archives from the pgBackRest repository for the specified stanza.

To delete a stanza:

-   Shut down the PostgreSQL cluster associated with the stanza (or use --force to override).
-   Run the stop command on the host where the stanza-delete command will be run.
-   Run the stanza-delete command.

Once the command successfully completes, it is the responsibility of the user to remove the stanza from all pgBackRest configuration files and/or environment variables.

A stanza may only be deleted from one repository at a time. To delete the stanza from multiple repositories, repeat the stanza-delete command for each repository while specifying the --repo option.

### Command Options

Command Options

#### Force (--force)

Force (--force)

Force stanza delete.

If PostgreSQL is still running for the stanza, then this option can be used to force the stanza to be deleted from the repository.

```
default: n
example: --no-force
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Database Timeout (--db-timeout)](configuration.html#section-general/option-db-timeout)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Database (--pg-database)](configuration.html#section-stanza/option-pg-database)
-   [PostgreSQL Host (--pg-host)](configuration.html#section-stanza/option-pg-host)
-   [PostgreSQL Host Certificate Authority File (--pg-host-ca-file)](configuration.html#section-stanza/option-pg-host-ca-file)
-   [PostgreSQL Host Certificate Authority Path (--pg-host-ca-path)](configuration.html#section-stanza/option-pg-host-ca-path)
-   [PostgreSQL Host Certificate File (--pg-host-cert-file)](configuration.html#section-stanza/option-pg-host-cert-file)
-   [PostgreSQL Host Command (--pg-host-cmd)](configuration.html#section-stanza/option-pg-host-cmd)
-   [PostgreSQL Host Configuration (--pg-host-config)](configuration.html#section-stanza/option-pg-host-config)
-   [PostgreSQL Host Configuration Include Path (--pg-host-config-include-path)](configuration.html#section-stanza/option-pg-host-config-include-path)
-   [PostgreSQL Host Configuration Path (--pg-host-config-path)](configuration.html#section-stanza/option-pg-host-config-path)
-   [PostgreSQL Host Key File (--pg-host-key-file)](configuration.html#section-stanza/option-pg-host-key-file)
-   [PostgreSQL Host Port (--pg-host-port)](configuration.html#section-stanza/option-pg-host-port)
-   [PostgreSQL Host Protocol Type (--pg-host-type)](configuration.html#section-stanza/option-pg-host-type)
-   [PostgreSQL Host User (--pg-host-user)](configuration.html#section-stanza/option-pg-host-user)
-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)
-   [PostgreSQL Port (--pg-port)](configuration.html#section-stanza/option-pg-port)
-   [PostgreSQL Socket Path (--pg-socket-path)](configuration.html#section-stanza/option-pg-socket-path)
-   [PostgreSQL Database User (--pg-user)](configuration.html#section-stanza/option-pg-user)

## Stanza Upgrade (stanza-upgrade)

Stanza Upgrade (stanza-upgrade)

Immediately after upgrading PostgreSQL to a newer major version, the pg-path for all pgBackRest configurations must be set to the new database location and the stanza-upgrade command run. If there is more than one repository configured on the host, the stanza will be upgraded on each. If the database is offline use the --no-online option.

### Command Options

Command Options

#### Online (--online)

Online (--online)

Update an online cluster.

Specifying --no-online prevents pgBackRest from connecting to PostgreSQL when upgrading the stanza.

```
default: y
example: --no-online
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Database Timeout (--db-timeout)](configuration.html#section-general/option-db-timeout)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

### Stanza Options

Stanza Options

-   [PostgreSQL Database (--pg-database)](configuration.html#section-stanza/option-pg-database)
-   [PostgreSQL Host (--pg-host)](configuration.html#section-stanza/option-pg-host)
-   [PostgreSQL Host Certificate Authority File (--pg-host-ca-file)](configuration.html#section-stanza/option-pg-host-ca-file)
-   [PostgreSQL Host Certificate Authority Path (--pg-host-ca-path)](configuration.html#section-stanza/option-pg-host-ca-path)
-   [PostgreSQL Host Certificate File (--pg-host-cert-file)](configuration.html#section-stanza/option-pg-host-cert-file)
-   [PostgreSQL Host Command (--pg-host-cmd)](configuration.html#section-stanza/option-pg-host-cmd)
-   [PostgreSQL Host Configuration (--pg-host-config)](configuration.html#section-stanza/option-pg-host-config)
-   [PostgreSQL Host Configuration Include Path (--pg-host-config-include-path)](configuration.html#section-stanza/option-pg-host-config-include-path)
-   [PostgreSQL Host Configuration Path (--pg-host-config-path)](configuration.html#section-stanza/option-pg-host-config-path)
-   [PostgreSQL Host Key File (--pg-host-key-file)](configuration.html#section-stanza/option-pg-host-key-file)
-   [PostgreSQL Host Port (--pg-host-port)](configuration.html#section-stanza/option-pg-host-port)
-   [PostgreSQL Host Protocol Type (--pg-host-type)](configuration.html#section-stanza/option-pg-host-type)
-   [PostgreSQL Host User (--pg-host-user)](configuration.html#section-stanza/option-pg-host-user)
-   [PostgreSQL Path (--pg-path)](configuration.html#section-stanza/option-pg-path)
-   [PostgreSQL Port (--pg-port)](configuration.html#section-stanza/option-pg-port)
-   [PostgreSQL Socket Path (--pg-socket-path)](configuration.html#section-stanza/option-pg-socket-path)
-   [PostgreSQL Database User (--pg-user)](configuration.html#section-stanza/option-pg-user)

## Stanza Start (start)

Stanza Start (start)

If the pgBackRest processes were previously stopped using the stop command then they can be started again using the start command. Note that this will not immediately start up any pgBackRest processes but they are allowed to run. See [Starting and Stopping](user-guide.html#start-stop) for more information and examples.

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Stanza (--stanza)](#section-general/option-stanza)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

## Stanza Stop (stop)

Stanza Stop (stop)

Does not allow any new pgBackRest processes to run. By default running processes will be allowed to complete successfully. Use the --force option to terminate running processes.

pgBackRest processes will return an error if they are run after the stop command completes. See [Starting and Stopping](user-guide.html#start-stop) for more information and examples.

### Command Options

Command Options

#### Force (--force)

Force (--force)

Force all pgBackRest processes to stop.

This option will send TERM signals to all running pgBackRest processes to effect a graceful but immediate shutdown. Note that this will also shutdown processes that were initiated on another system but have remotes running on the current system. For instance, if a backup was started on the backup server then running stop --force on the database server will shutdown the backup process on the backup server.

```
default: n
example: --force
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [Lock Path (--lock-path)](configuration.html#section-general/option-lock-path)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Stanza (--stanza)](#section-general/option-stanza)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

## Repository Verify (verify)

Repository Verify (verify)

Verify determines if the backups and archives in a repository are valid.

### Command Options

Command Options

#### Output (--output)

Output (--output)

Output type.

The following output types are supported:

-   none - No verify output.
-   text - Output verify information to stdout.

```
default: none
example: --output=text
```

#### Set (--set)

Set (--set)

Backup set to verify.

Verify all database and archive files associated with the specified backup set.

```
example: --set=20150131-153358F_20150131-153401I
```

#### Verbose (--verbose)

Verbose (--verbose)

Verbose output.

Verbose defaults to false, providing a minimal response with important information about errors in the repository. Specifying true provides more information about what was successfully verified.

```
default: n
example: --verbose
```

### General Options

General Options

-   [Allow Run as Root (--allow-root)](configuration.html#section-general/option-allow-root)
-   [Buffer Size (--buffer-size)](configuration.html#section-general/option-buffer-size)
-   [pgBackRest Command (--cmd)](configuration.html#section-general/option-cmd)
-   [SSH Client Command (--cmd-ssh)](configuration.html#section-general/option-cmd-ssh)
-   [Network Compress Level (--compress-level-network)](configuration.html#section-general/option-compress-level-network)
-   [Config (--config)](#section-general/option-config)
-   [Config Include Path (--config-include-path)](#section-general/option-config-include-path)
-   [Config Path (--config-path)](#section-general/option-config-path)
-   [I/O Timeout (--io-timeout)](configuration.html#section-general/option-io-timeout)
-   [Neutral Umask (--neutral-umask)](configuration.html#section-general/option-neutral-umask)
-   [Set Process Priority (--priority)](configuration.html#section-general/option-priority)
-   [Process Maximum (--process-max)](configuration.html#section-general/option-process-max)
-   [Protocol Timeout (--protocol-timeout)](configuration.html#section-general/option-protocol-timeout)
-   [Socket Keep Alive (--sck-keep-alive)](configuration.html#section-general/option-sck-keep-alive)
-   [Stanza (--stanza)](#section-general/option-stanza)
-   [TCP Keep Alive Count (--tcp-keep-alive-count)](configuration.html#section-general/option-tcp-keep-alive-count)
-   [TCP Keep Alive Idle (--tcp-keep-alive-idle)](configuration.html#section-general/option-tcp-keep-alive-idle)
-   [TCP Keep Alive Interval (--tcp-keep-alive-interval)](configuration.html#section-general/option-tcp-keep-alive-interval)
-   [TLSv1.2 Cipher Suites (--tls-cipher-12)](configuration.html#section-general/option-tls-cipher-12)
-   [TLSv1.3 Cipher Suites (--tls-cipher-13)](configuration.html#section-general/option-tls-cipher-13)

### Log Options

Log Options

-   [Console Log Level (--log-level-console)](configuration.html#section-log/option-log-level-console)
-   [File Log Level (--log-level-file)](configuration.html#section-log/option-log-level-file)
-   [Std Error Log Level (--log-level-stderr)](configuration.html#section-log/option-log-level-stderr)
-   [Log Path (--log-path)](configuration.html#section-log/option-log-path)
-   [Log Subprocesses (--log-subprocess)](configuration.html#section-log/option-log-subprocess)
-   [Log Timestamp (--log-timestamp)](configuration.html#section-log/option-log-timestamp)

### Maintainer Options

Maintainer Options

-   [Force PostgreSQL Version (--pg-version-force)](configuration.html#section-maintainer/option-pg-version-force)

### Repository Options

Repository Options

-   [Set Repository (--repo)](#section-general/option-repo)
-   [Azure Repository Container (--repo-azure-container)](configuration.html#section-repository/option-repo-azure-container)
-   [Azure Repository Key Type (--repo-azure-key-type)](configuration.html#section-repository/option-repo-azure-key-type)
-   [Azure Repository URI Style (--repo-azure-uri-style)](configuration.html#section-repository/option-repo-azure-uri-style)
-   [Repository Cipher Type (--repo-cipher-type)](configuration.html#section-repository/option-repo-cipher-type)
-   [GCS Repository Bucket (--repo-gcs-bucket)](configuration.html#section-repository/option-repo-gcs-bucket)
-   [GCS Repository Endpoint (--repo-gcs-endpoint)](configuration.html#section-repository/option-repo-gcs-endpoint)
-   [GCS Repository Key Type (--repo-gcs-key-type)](configuration.html#section-repository/option-repo-gcs-key-type)
-   [GCS Repository Project ID (--repo-gcs-user-project)](configuration.html#section-repository/option-repo-gcs-user-project)
-   [Repository Host (--repo-host)](configuration.html#section-repository/option-repo-host)
-   [Repository Host Certificate Authority File (--repo-host-ca-file)](configuration.html#section-repository/option-repo-host-ca-file)
-   [Repository Host Certificate Authority Path (--repo-host-ca-path)](configuration.html#section-repository/option-repo-host-ca-path)
-   [Repository Host Certificate File (--repo-host-cert-file)](configuration.html#section-repository/option-repo-host-cert-file)
-   [Repository Host Command (--repo-host-cmd)](configuration.html#section-repository/option-repo-host-cmd)
-   [Repository Host Configuration (--repo-host-config)](configuration.html#section-repository/option-repo-host-config)
-   [Repository Host Configuration Include Path (--repo-host-config-include-path)](configuration.html#section-repository/option-repo-host-config-include-path)
-   [Repository Host Configuration Path (--repo-host-config-path)](configuration.html#section-repository/option-repo-host-config-path)
-   [Repository Host Key File (--repo-host-key-file)](configuration.html#section-repository/option-repo-host-key-file)
-   [Repository Host Port (--repo-host-port)](configuration.html#section-repository/option-repo-host-port)
-   [Repository Host Protocol Type (--repo-host-type)](configuration.html#section-repository/option-repo-host-type)
-   [Repository Host User (--repo-host-user)](configuration.html#section-repository/option-repo-host-user)
-   [Repository Path (--repo-path)](configuration.html#section-repository/option-repo-path)
-   [S3 Repository Bucket (--repo-s3-bucket)](configuration.html#section-repository/option-repo-s3-bucket)
-   [S3 Repository Endpoint (--repo-s3-endpoint)](configuration.html#section-repository/option-repo-s3-endpoint)
-   [S3 Repository Key Type (--repo-s3-key-type)](configuration.html#section-repository/option-repo-s3-key-type)
-   [S3 Repository KMS Key ID (--repo-s3-kms-key-id)](configuration.html#section-repository/option-repo-s3-kms-key-id)
-   [S3 Authentication Process Command (--repo-s3-process-cmd)](configuration.html#section-repository/option-repo-s3-process-cmd)
-   [S3 Repository Region (--repo-s3-region)](configuration.html#section-repository/option-repo-s3-region)
-   [S3 Repository Requestor Pays (--repo-s3-requester-pays)](configuration.html#section-repository/option-repo-s3-requester-pays)
-   [S3 Repository Role (--repo-s3-role)](configuration.html#section-repository/option-repo-s3-role)
-   [S3 Repository Service (--repo-s3-service)](configuration.html#section-repository/option-repo-s3-service)
-   [S3 Repository STS Endpoint (--repo-s3-sts-host)](configuration.html#section-repository/option-repo-s3-sts-host)
-   [S3 Repository URI Style (--repo-s3-uri-style)](configuration.html#section-repository/option-repo-s3-uri-style)
-   [SFTP Repository Host (--repo-sftp-host)](configuration.html#section-repository/option-repo-sftp-host)
-   [SFTP Repository Host Fingerprint (--repo-sftp-host-fingerprint)](configuration.html#section-repository/option-repo-sftp-host-fingerprint)
-   [SFTP Host Key Check Type (--repo-sftp-host-key-check-type)](configuration.html#section-repository/option-repo-sftp-host-key-check-type)
-   [SFTP Repository Host Key Hash Type (--repo-sftp-host-key-hash-type)](configuration.html#section-repository/option-repo-sftp-host-key-hash-type)
-   [SFTP Repository Host Port (--repo-sftp-host-port)](configuration.html#section-repository/option-repo-sftp-host-port)
-   [SFTP Repository Host User (--repo-sftp-host-user)](configuration.html#section-repository/option-repo-sftp-host-user)
-   [SFTP Known Hosts File (--repo-sftp-known-host)](configuration.html#section-repository/option-repo-sftp-known-host)
-   [SFTP Repository Private Key File (--repo-sftp-private-key-file)](configuration.html#section-repository/option-repo-sftp-private-key-file)
-   [SFTP Repository Public Key File (--repo-sftp-public-key-file)](configuration.html#section-repository/option-repo-sftp-public-key-file)
-   [Repository Storage CA File (--repo-storage-ca-file)](configuration.html#section-repository/option-repo-storage-ca-file)
-   [Repository Storage TLS CA Path (--repo-storage-ca-path)](configuration.html#section-repository/option-repo-storage-ca-path)
-   [Repository Storage Host (--repo-storage-host)](configuration.html#section-repository/option-repo-storage-host)
-   [Repository Storage Port (--repo-storage-port)](configuration.html#section-repository/option-repo-storage-port)
-   [Repository Storage Prefetch (--repo-storage-prefetch)](configuration.html#section-repository/option-repo-storage-prefetch)
-   [Repository Storage Read Over (--repo-storage-read-over)](configuration.html#section-repository/option-repo-storage-read-over)
-   [Repository Storage Tag (--repo-storage-tag)](configuration.html#section-repository/option-repo-storage-tag)
-   [Repository Storage Upload Chunk Size (--repo-storage-upload-chunk-size)](configuration.html#section-repository/option-repo-storage-upload-chunk-size)
-   [Repository Storage Certificate Verify (--repo-storage-verify-tls)](configuration.html#section-repository/option-repo-storage-verify-tls)
-   [Target Time for Repository (--repo-target-time)](configuration.html#section-repository/option-repo-target-time)
-   [Repository Type (--repo-type)](configuration.html#section-repository/option-repo-type)

## Version (version)

Version (version)

Displays installed pgBackRest version.

### Command Options

Command Options

#### Output (--output)

Output (--output)

Output type.

The following output types are supported:

-   text - Display the installed pgBackRest version as text.
-   num - Display the installed pgBackRest version as an integer.

```
default: text
example: --output=num
```

Copyright © 2015-2026, The PostgreSQL Global Development Group, [MIT License](https://github.com/pgbackrest/pgbackrest/blob/main/LICENSE). Updated October 17, 2026

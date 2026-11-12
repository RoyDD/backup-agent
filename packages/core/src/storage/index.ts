/**
 * Storage implementations. `FetchLike` from the S3 module is re-exported as
 * `S3FetchLike` to avoid colliding with `ops/notify`'s fetch type at the core
 * barrel; the signer itself is exported because it is the part worth testing
 * without a network.
 */
export * from './fs-storage'
export type {
  FetchResponseLike as S3FetchResponseLike,
  FetchLike as S3FetchLike,
  S3StorageOptions,
  SigV4Input,
  SigV4Result,
} from './s3-storage'
export { S3Storage, canonicalQueryString, signV4Request } from './s3-storage'

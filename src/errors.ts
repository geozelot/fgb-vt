/**
 * @module errors
 *
 * Typed errors raised by fgb-vt.
 *
 * Every error thrown by the library for a data or I/O problem is an
 * {@link FgbVtError}, so callers can tell them apart from programming
 * errors and react by kind:
 *
 * | Class | `code` | Meaning |
 * |-------|--------|---------|
 * | {@link FormatError} | `FGB_FORMAT` | The file is not valid FlatGeobuf (corrupt, truncated, inconsistent). |
 * | {@link UnsupportedFormatError} | `FGB_UNSUPPORTED` | Valid FlatGeobuf that this reader does not support (e.g. major version 2). |
 * | {@link ConnectorError} | `FGB_IO` | Reading from storage failed. |
 * | {@link RangeNotSupportedError} | `FGB_RANGE_UNSUPPORTED` | The server ignores byte-range requests. |
 * | {@link SourceChangedError} | `FGB_SOURCE_CHANGED` | The file changed between reads (version tag mismatch). |
 * | {@link LimitExceededError} | `FGB_LIMIT` | A configured safety limit was reached. |
 *
 * Invalid arguments (e.g. tile coordinates out of range) raise the
 * standard `RangeError` / `TypeError` instead.
 */

/** Common base class of all fgb-vt errors. */
export class FgbVtError extends Error {
  /** Stable machine-readable error code. */
  readonly code: string;
  /** Path of the FlatGeobuf source involved, when known. */
  path?: string;

  constructor(code: string, message: string, options?: { path?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    if (options?.path !== undefined) this.path = options.path;
  }
}

/** The data is not valid FlatGeobuf: corrupt, truncated or inconsistent. */
export class FormatError extends FgbVtError {
  /** Byte offset in the file where the problem was detected, when known. */
  readonly offset?: number;

  constructor(message: string, options?: { path?: string; offset?: number; cause?: unknown }) {
    super('FGB_FORMAT', message, options);
    if (options?.offset !== undefined) this.offset = options.offset;
  }
}

/** Valid FlatGeobuf that uses a feature this reader does not support. */
export class UnsupportedFormatError extends FgbVtError {
  constructor(message: string, options?: { path?: string; cause?: unknown }) {
    super('FGB_UNSUPPORTED', message, options);
  }
}

/** Reading from the underlying storage failed. */
export class ConnectorError extends FgbVtError {
  /** Whether retrying the same request may succeed. */
  readonly retryable: boolean;
  /** HTTP status code, for HTTP-based connectors. */
  readonly status?: number;

  constructor(
    message: string,
    options?: { path?: string; retryable?: boolean; status?: number; cause?: unknown; code?: string },
  ) {
    super(options?.code ?? 'FGB_IO', message, options);
    this.retryable = options?.retryable ?? false;
    if (options?.status !== undefined) this.status = options.status;
  }
}

/** The server answered a byte-range request with the whole resource. */
export class RangeNotSupportedError extends ConnectorError {
  constructor(message: string, options?: { path?: string; status?: number }) {
    super(message, { ...options, retryable: false, code: 'FGB_RANGE_UNSUPPORTED' });
  }
}

/**
 * The resource changed since its header was read: its version tag (ETag,
 * or size and modification time for local files) no longer matches.
 *
 * The tile pipeline handles this itself by reopening the source once;
 * it only reaches callers if the file keeps changing.
 */
export class SourceChangedError extends ConnectorError {
  constructor(message: string, options?: { path?: string; status?: number }) {
    super(message, { ...options, retryable: false, code: 'FGB_SOURCE_CHANGED' });
  }
}

/** A configured safety limit (e.g. the scan budget for unindexed files) was reached. */
export class LimitExceededError extends FgbVtError {
  constructor(message: string, options?: { path?: string }) {
    super('FGB_LIMIT', message, options);
  }
}

/**
 * Attach a source path to an fgb-vt error that does not carry one yet.
 *
 * Low-level decoders do not know which file they are decoding; the
 * pipeline annotates their errors on the way out.
 *
 * @param err - Any thrown value.
 * @param path - Source path to attach.
 * @returns `err`, for rethrowing.
 */
export function withPath(err: unknown, path: string): unknown {
  if (err instanceof FgbVtError && err.path === undefined) err.path = path;
  return err;
}

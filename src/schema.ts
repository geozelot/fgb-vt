/**
 * @module schema
 *
 * Per-source property selection and feature id configuration.
 *
 * A source can limit the properties written to its layer
 * ({@link Source.properties}) and choose the column that provides MVT
 * feature ids ({@link Source.idColumn}). Both are applied while features
 * are decoded, so dropped string properties are never decoded at all.
 */

import type { Source } from './source.js';
import type { ColumnMeta, FgbHeader } from './types.js';
import { ColumnType } from './types.js';
import { isIntegerColumnType } from './fgb/header.js';

/**
 * Properties to write for a source: the names to keep, or the names to
 * drop (`{ exclude: [...] }`).
 */
export type PropertySelection = readonly string[] | { readonly exclude: readonly string[] };

/**
 * Resolved decoding settings for one source.
 */
export interface FeatureSchema {
  /** Whether a property is written; `null` writes all. */
  keep: ((name: string) => boolean) | null;
  /**
   * Column providing the feature id: `undefined` detects it (an integer
   * column named `id`, `fid`, `gid` or `ogc_fid`), `false` writes no ids.
   */
  idColumn: string | false | undefined;
  /** Also write the id column as a property. */
  keepId: boolean;
}

/** Settings of a source without property or id configuration. */
export const DEFAULT_SCHEMA: FeatureSchema = { keep: null, idColumn: undefined, keepId: false };

const schemas = new WeakMap<Source, FeatureSchema>();

/**
 * Resolve the decoding settings of a source.
 *
 * @param source - Source descriptor.
 * @returns Its property filter and id settings (cached per source object).
 */
export function featureSchema(source: Source): FeatureSchema {
  if (source.properties === undefined && source.idColumn === undefined && !source.keepIdProperty) {
    return DEFAULT_SCHEMA;
  }
  let schema = schemas.get(source);
  if (!schema) {
    const selection = source.properties;
    let keep: FeatureSchema['keep'] = null;
    if (Array.isArray(selection)) {
      const names = new Set<string>(selection);
      keep = (name) => names.has(name);
    } else if (selection) {
      const names = new Set<string>((selection as { exclude: readonly string[] }).exclude);
      keep = (name) => !names.has(name);
    }
    schema = { keep, idColumn: source.idColumn, keepId: source.keepIdProperty ?? false };
    schemas.set(source, schema);
  }
  return schema;
}

/**
 * Check a source's id column against the file's header schema.
 *
 * Files that declare their columns per feature (an empty header schema)
 * are not checked.
 *
 * @param schema - Resolved settings of the source.
 * @param header - Parsed header of the source file.
 * @param path - Source path, for the error message.
 * @throws {RangeError} If the named id column does not exist or is not an
 *   integer column (MVT ids are unsigned integers).
 */
export function validateSchema(schema: FeatureSchema, header: FgbHeader, path: string): void {
  const { idColumn } = schema;
  if (typeof idColumn !== 'string' || header.columns.length === 0) return;
  const column = header.columns.find(c => c.name === idColumn);
  if (!column) {
    throw new RangeError(`idColumn "${idColumn}" is not a column of ${path}`);
  }
  if (!isIntegerColumnType(column.type)) {
    throw new RangeError(`idColumn "${idColumn}" of ${path} is not an integer column`);
  }
}

/**
 * Index of the id column within a column schema.
 *
 * @param schema - Resolved settings of the source.
 * @param columns - Column schema (header or per-feature).
 * @param detected - Auto-detected id column index for `columns`.
 * @returns The column index, or `-1` for no id column.
 */
export function idColumnIndex(schema: FeatureSchema, columns: ColumnMeta[], detected: number): number {
  if (schema.idColumn === false) return -1;
  if (schema.idColumn === undefined) return detected;
  const i = columns.findIndex(c => c.name === schema.idColumn);
  return i >= 0 && isIntegerColumnType(columns[i].type) ? i : -1;
}

/**
 * The header columns that end up as properties in the tile: those passing
 * the selection, except binary columns (MVT has no binary values) and the
 * id column unless it is kept.
 *
 * @param schema - Resolved settings of the source.
 * @param header - Parsed header.
 * @returns Columns written as properties, in schema order.
 */
export function emittedColumns(schema: FeatureSchema, header: FgbHeader): ColumnMeta[] {
  const id = idColumnIndex(schema, header.columns, header.idColumnIndex);
  return header.columns.filter((c, i) =>
    c.type !== ColumnType.Binary &&
    (schema.keep === null || schema.keep(c.name)) &&
    (i !== id || schema.keepId));
}

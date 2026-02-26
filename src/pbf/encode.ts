/**
 * @module pbf/encode
 *
 * MVT PBF encoder -- serializes {@link MvtLayer} structures into a binary
 * Protocol Buffer payload conforming to the Mapbox Vector Tile 2.1 specification.
 *
 * The MVT protobuf schema used by this encoder:
 *
 * ```protobuf
 * message Tile {
 *   repeated Layer layers = 3;
 *
 *   message Layer {
 *     required uint32 version  = 15; // always 2
 *     required string name     = 1;
 *     repeated Feature features = 2;
 *     repeated string keys     = 3;
 *     repeated Value  values   = 4;
 *     optional uint32 extent   = 5;  // default 4096
 *   }
 *
 *   message Feature {
 *     optional uint64        id       = 1;
 *     repeated uint32        tags     = 2 [packed = true];
 *     optional GeomType      type     = 3;
 *     repeated uint32        geometry = 4 [packed = true];
 *   }
 *
 *   message Value {
 *     optional string  string_value = 1;
 *     optional float   float_value  = 2;
 *     optional double  double_value = 3;
 *     optional int64   int_value    = 4;
 *     optional uint64  uint_value   = 5;
 *     optional sint64  sint_value   = 6;
 *     optional bool    bool_value   = 7;
 *   }
 *
 *   enum GeomType {
 *     UNKNOWN    = 0;
 *     POINT      = 1;
 *     LINESTRING = 2;
 *     POLYGON    = 3;
 *   }
 * }
 * ```
 *
 * @see {@link https://github.com/mapbox/vector-tile-spec/blob/master/2.1/vector_tile.proto | MVT 2.1 Proto}
 */

import { PbfWriter } from './writer.js';
import type { MvtLayer, MvtFeature, MvtValue } from '../types.js';

/**
 * Encode one or more MVT layers into a binary PBF tile.
 *
 * Each layer is written as a nested `Tile.Layer` message (field 3 of the
 * top-level `Tile`). The resulting byte array can be served directly as
 * an `application/vnd.mapbox-vector-tile` response body, optionally after
 * gzip compression.
 *
 * @param layers - Array of fully assembled MVT layers (as produced by
 *   {@link buildMvtLayer}).
 * @returns A `Uint8Array` containing the complete PBF-encoded tile.
 */
export function encodePbf(layers: MvtLayer[]): Uint8Array {
  const writer = new PbfWriter();

  for (const layer of layers) {
    writeLayer(writer, layer);
  }

  return writer.finish();
}

/**
 * Write a single `Tile.Layer` message (field 3 of `Tile`).
 *
 * Emits the layer version (always 2), name, extent, all deduplicated keys
 * and values, and every feature as nested sub-messages.
 *
 * @param writer - PBF writer instance positioned inside the tile.
 * @param layer - The MVT layer to serialize.
 */
function writeLayer(writer: PbfWriter, layer: MvtLayer): void {
  // Layer is field 3 of Tile
  writer.beginMessage(3);

  // version = 2 (field 15)
  writer.writeVarintField(15, 2);

  // name (field 1)
  writer.writeStringField(1, layer.name);

  // extent (field 5)
  writer.writeVarintField(5, layer.extent);

  // keys (field 3, repeated string)
  for (const key of layer.keys) {
    writer.writeStringField(3, key);
  }

  // values (field 4, repeated message)
  for (const value of layer.values) {
    writeValue(writer, value);
  }

  // features (field 2, repeated message)
  for (const feature of layer.features) {
    writeFeature(writer, feature);
  }

  writer.endMessage();
}

/**
 * Write a single `Tile.Feature` message (field 2 of `Layer`).
 *
 * The feature ID is written only when present (non-null). Tags and geometry
 * are written as packed repeated varint fields for compactness; empty arrays
 * are omitted entirely per protobuf convention.
 *
 * @param writer - PBF writer instance positioned inside the layer message.
 * @param feature - The MVT feature to serialize.
 */
function writeFeature(writer: PbfWriter, feature: MvtFeature): void {
  // Feature is field 2 of Layer
  writer.beginMessage(2);

  // id (field 1, optional)
  if (feature.id !== null && feature.id !== undefined) {
    writer.writeVarintField(1, feature.id);
  }

  // tags (field 2, packed varint)
  if (feature.tags.length > 0) {
    writer.writePackedVarint(2, feature.tags);
  }

  // type (field 3)
  writer.writeVarintField(3, feature.type);

  // geometry (field 4, packed varint)
  if (feature.geometry.length > 0) {
    writer.writePackedVarint(4, feature.geometry);
  }

  writer.endMessage();
}

/**
 * Write a single `Tile.Value` message (field 4 of `Layer`).
 *
 * Exactly one of the typed value fields is written based on the
 * {@link MvtValue.type} discriminant:
 *
 * - `'string'` -- field 1 (string)
 * - `'double'` -- field 3 (double, 64-bit float)
 * - `'int'`    -- field 6 (sint64, zigzag-encoded)
 * - `'uint'`   -- field 5 (uint64)
 * - `'bool'`   -- field 7 (bool, varint 0/1)
 *
 * @param writer - PBF writer instance positioned inside the layer message.
 * @param value - The typed MVT value to serialize.
 */
function writeValue(writer: PbfWriter, value: MvtValue): void {
  // Value is field 4 of Layer
  writer.beginMessage(4);

  switch (value.type) {
    case 'string':
      writer.writeStringField(1, value.value);
      break;
    case 'double':
      writer.writeDoubleField(3, value.value);
      break;
    case 'int':
      writer.writeSVarintField(6, value.value);
      break;
    case 'uint':
      writer.writeVarintField(5, value.value);
      break;
    case 'bool':
      writer.writeBoolField(7, value.value);
      break;
  }

  writer.endMessage();
}

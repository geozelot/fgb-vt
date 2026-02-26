/** @module fgb/index
 *
 * Packed Hilbert R-tree spatial index query.
 *
 * The FGB v3 spatial index is a static packed R-tree where:
 * - Each node is exactly 40 bytes: 4 x `float64` for the bounding box
 *   (32 bytes) plus 1 x `uint64` for the offset (8 bytes).
 * - Nodes are arranged root-first: the root node occupies the lowest
 *   indices, followed by internal nodes in descending level order, with
 *   leaf nodes at the highest indices.
 * - Leaf node offsets store byte offsets into the feature data section.
 * - Internal node offsets store the node index of their first child.
 * - The tree is built from features sorted by their Hilbert curve value.
 *
 * The query traverses the tree top-down using an explicit stack, following
 * child pointers stored in internal node offsets. Leaf nodes whose bboxes
 * intersect the query extent are collected, and their stored byte offsets
 * are converted to absolute file positions. Returned ranges are sorted by
 * file offset and merged to minimize the number of read operations
 * required by the I/O layer.
 */

import type { BBox } from '../types.js';

/** Byte size of a single packed R-tree node (4 x f64 bbox + 1 x u64 offset). */
const NODE_ITEM_SIZE = 40;

/**
 * A contiguous byte range within the FGB file, expressed as an absolute
 * file offset and a byte length.
 */
export interface ByteRange {
  /** Absolute byte offset from the start of the file. */
  offset: number;
  /** Number of bytes in this range. */
  length: number;
}

/**
 * Query the packed Hilbert R-tree to find feature byte ranges that
 * intersect the given bounding box.
 *
 * The traversal proceeds top-down from the root. Internal nodes store
 * the node index of their first child in the offset field (bytes 32–39);
 * the query reads this pointer directly to locate children, clamping to
 * the child level's upper bound. Leaf nodes that pass the intersection
 * test are collected, and their stored byte offsets (relative to the
 * feature data section) are converted to absolute file positions using
 * `featuresOffset`. Adjacent or nearby ranges are merged before returning
 * to reduce the number of discrete I/O operations.
 *
 * @param indexBytes - Raw bytes of the spatial index section of the file.
 * @param featuresCount - Total number of features (leaf-level node count).
 * @param nodeSize - Branching factor of the R-tree (max children per
 *   internal node).
 * @param featuresOffset - Absolute byte offset where feature data begins
 *   in the file; added to each relative feature offset stored in the index.
 * @param bbox - Query bounding box. Coordinate reference system must match
 *   the index (typically WGS 84).
 * @returns Sorted, merged array of {@link ByteRange} entries representing
 *   the file regions that contain matching features. Returns an empty array
 *   if no features intersect or if the index is empty.
 */
export function queryIndex(
  indexBytes: Uint8Array,
  featuresCount: number,
  nodeSize: number,
  featuresOffset: number,
  bbox: BBox,
): ByteRange[] {
  if (featuresCount === 0 || nodeSize === 0) return [];

  const view = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);

  // Calculate level bounds (root-first tree layout)
  const levelBounds = computeLevelBounds(featuresCount, nodeSize);
  const numLevels = levelBounds.length;

  // Leaf level bounds (level 0)
  const leafEnd = levelBounds[0][1];

  // Collect matching leaf node indices
  const matchingLeafIndices: number[] = [];

  // Stack-based top-down traversal: [nodeIndex, level]
  const stack: number[] = [];

  // Start from root level (highest level index)
  const rootLevel = numLevels - 1;
  const [rootStart, rootEnd] = levelBounds[rootLevel];

  for (let i = rootStart; i < rootEnd; i++) {
    stack.push(i, rootLevel);
  }

  while (stack.length > 0) {
    const level = stack.pop()!;
    const nodeIdx = stack.pop()!;

    // Read node bbox
    const nodeByteOff = nodeIdx * NODE_ITEM_SIZE;
    if (nodeByteOff + NODE_ITEM_SIZE > indexBytes.length) break;

    const nodeMinX = view.getFloat64(nodeByteOff, true);
    const nodeMinY = view.getFloat64(nodeByteOff + 8, true);
    const nodeMaxX = view.getFloat64(nodeByteOff + 16, true);
    const nodeMaxY = view.getFloat64(nodeByteOff + 24, true);

    // Intersection test
    if (nodeMaxX < bbox.minX || nodeMinX > bbox.maxX ||
        nodeMaxY < bbox.minY || nodeMinY > bbox.maxY) {
      continue;
    }

    if (level === 0) {
      // Leaf node: this is a feature reference
      matchingLeafIndices.push(nodeIdx);
    } else {
      // Internal node: read first-child index from offset field
      const firstChild = readUint64AsNumber(view, nodeByteOff + 32);
      const childLevelEnd = levelBounds[level - 1][1];
      const childEnd = Math.min(firstChild + nodeSize, childLevelEnd);

      for (let i = firstChild; i < childEnd; i++) {
        stack.push(i, level - 1);
      }
    }
  }

  if (matchingLeafIndices.length === 0) return [];

  // Sort by node index for sequential access and offset derivation
  matchingLeafIndices.sort((a, b) => a - b);

  // Convert leaf indices to byte ranges.
  // Leaf nodes store byte offsets (relative to featuresOffset) in their
  // offset field. Feature length is derived from the difference to the
  // next leaf's offset, since features are stored contiguously in
  // Hilbert-sorted order matching the leaf order.
  const ranges: ByteRange[] = [];
  for (const nodeIdx of matchingLeafIndices) {
    const nodeByteOff = nodeIdx * NODE_ITEM_SIZE;
    const featureByteOffset = readUint64AsNumber(view, nodeByteOff + 32);

    let featureLength: number;
    if (nodeIdx + 1 < leafEnd) {
      const nextByteOffset = readUint64AsNumber(view, (nodeIdx + 1) * NODE_ITEM_SIZE + 32);
      featureLength = nextByteOffset - featureByteOffset;
    } else {
      // Last feature: exact length unknown; use a generous upper bound
      featureLength = 1024 * 1024;
    }

    ranges.push({
      offset: featuresOffset + featureByteOffset,
      length: featureLength,
    });
  }

  return mergeRanges(ranges);
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Compute the node-index boundaries for each level of the packed R-tree.
 *
 * The FlatGeobuf v3 packed Hilbert R-tree stores nodes root-first: the
 * root occupies the lowest node indices, followed by internal nodes in
 * descending level order, with leaf nodes at the highest indices.
 *
 * The returned array has one `[start, end)` pair per level, indexed by
 * level number. Level 0 is the leaf level (one node per feature); the
 * highest level is the root.
 *
 * Example for 3221 features, nodeSize 16 (3437 total nodes):
 * ```
 *   Level 3 (root):   [0, 1)
 *   Level 2:          [1, 14)
 *   Level 1:          [14, 216)
 *   Level 0 (leaves): [216, 3437)
 * ```
 *
 * @param featuresCount - Total number of features (leaf nodes at level 0).
 * @param nodeSize - Branching factor of the R-tree.
 * @returns Array of `[startIndex, endIndex)` pairs, one per level.
 *   `result[0]` = leaf bounds, `result[result.length - 1]` = root bounds.
 */
function computeLevelBounds(
  featuresCount: number,
  nodeSize: number,
): Array<[number, number]> {
  // Count nodes at each level, starting from the leaf level
  let n = featuresCount;
  const levelNumNodes: number[] = [n];
  let numNodes = n;

  while (n > 1) {
    n = Math.ceil(n / nodeSize);
    levelNumNodes.push(n);
    numNodes += n;
  }

  // Assign node-index ranges: root starts at index 0, leaves at the end.
  // levelNumNodes[0] = leaf count, levelNumNodes[last] = root count (1).
  const levelBounds: Array<[number, number]> = new Array(levelNumNodes.length);
  let offset = 0;
  for (let i = levelNumNodes.length - 1; i >= 0; i--) {
    levelBounds[i] = [offset, offset + levelNumNodes[i]];
    offset += levelNumNodes[i];
  }

  return levelBounds;
}

/**
 * Read an unsigned 64-bit integer from a `DataView` as a JavaScript
 * `number`, reconstructed from two 32-bit halves.
 *
 * @param view - DataView to read from.
 * @param offset - Byte offset of the `uint64` within the view.
 * @returns The `uint64` value approximated as a `number`.
 */
function readUint64AsNumber(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x100000000 + lo;
}

/**
 * Merge overlapping or adjacent byte ranges to minimize the number of
 * discrete read operations.
 *
 * Two ranges are merged if the start of the second falls within `gap`
 * bytes of the end of the first. This coalesces nearby reads into a
 * single larger read, trading a small amount of over-fetching for fewer
 * I/O round-trips.
 *
 * @param ranges - Byte ranges sorted in ascending order by offset.
 * @param gap - Maximum byte distance between two ranges that still
 *   triggers a merge. Defaults to `512`.
 * @returns A new array of merged byte ranges.
 */
function mergeRanges(ranges: ByteRange[], gap: number = 512): ByteRange[] {
  if (ranges.length <= 1) return ranges;

  const merged: ByteRange[] = [{ ...ranges[0] }];

  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = ranges[i];
    const prevEnd = prev.offset + prev.length;

    // Merge if overlapping or within `gap` bytes of each other
    if (curr.offset <= prevEnd + gap) {
      const newEnd = Math.max(prevEnd, curr.offset + curr.length);
      prev.length = newEnd - prev.offset;
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

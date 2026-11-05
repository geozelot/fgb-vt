/** @module fgb/index
 *
 * Packed Hilbert R-tree layout.
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
 * This module computes the layout (level bounds and tree size); the
 * search itself streams index pages in {@link FgbSource} (`fgb/reader`).
 */

import { FormatError } from '../errors.js';

/** Byte size of a single packed R-tree node (4 x f64 bbox + 1 x u64 offset). */
const NODE_ITEM_SIZE = 40;

// == Internals ==============================================================

/**
 * Count the nodes on each level of a packed R-tree, leaf level first.
 *
 * Matches the reference implementation: the loop runs at least once, so
 * the tree always has a root above the leaves — a single-feature file has
 * two nodes (root + leaf), not one.
 *
 * @param featuresCount - Number of features (leaf nodes); must be >= 1.
 * @param nodeSize - Branching factor; must be >= 2.
 * @returns Node counts per level, `[leaves, ..., 1]`.
 * @throws {FormatError} On a feature count < 1 or a node size < 2.
 */
function levelNodeCounts(featuresCount: number, nodeSize: number): number[] {
  if (!Number.isSafeInteger(featuresCount) || featuresCount < 1) {
    throw new FormatError(`Invalid packed R-tree: feature count ${featuresCount}`);
  }
  if (!Number.isInteger(nodeSize) || nodeSize < 2 || nodeSize > 65535) {
    throw new FormatError(`Invalid packed R-tree: node size ${nodeSize}`);
  }
  let n = featuresCount;
  const counts = [n];
  do {
    n = Math.ceil(n / nodeSize);
    counts.push(n);
  } while (n !== 1);
  return counts;
}

/**
 * Calculate the byte size of a packed Hilbert R-tree index.
 *
 * Each node occupies exactly 40 bytes: 4 x `float64` for the bounding box
 * (32 bytes) plus 1 x `uint64` for the offset (8 bytes). The total size is
 * the sum of nodes across all tree levels.
 *
 * @param featuresCount - Total number of features (leaf nodes); must be >= 1.
 * @param nodeSize - Branching factor (max children per internal node); must be >= 2.
 * @returns Total byte size of the packed R-tree.
 * @throws {FormatError} On a feature count < 1 or a node size < 2.
 */
export function calcTreeSize(featuresCount: number, nodeSize: number): number {
  let total = 0;
  for (const n of levelNodeCounts(featuresCount, nodeSize)) total += n;
  return total * NODE_ITEM_SIZE;
}

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
 * @throws {FormatError} On a feature count < 1 or a node size < 2.
 */
export function computeLevelBounds(
  featuresCount: number,
  nodeSize: number,
): Array<[number, number]> {
  // Count nodes at each level, starting from the leaf level
  const levelNumNodes = levelNodeCounts(featuresCount, nodeSize);

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

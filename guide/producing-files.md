---
title: Producing files
---

# Producing files for fgb-vt

fgb-vt reads any FlatGeobuf 3.x file. How a file is written decides how fast tiles come out of it.

## Write with GDAL

```sh
ogr2ogr -f FlatGeobuf out.fgb input.gpkg -t_srs EPSG:4326 -nln parcels
```

GDAL writes a spatial index by default and stores features in index (Hilbert) order, which is what range reads need: the features of a tile sit close together in the file. Keep the index: without it, every tile scans the whole file (fgb-vt refuses beyond `maxScanBytes`, 32 MiB).

The index node size (GDAL's default 16) rarely needs changing. Larger nodes make the tree shallower (fewer index round trips) but each node covers a larger area, so more index bytes are read per tile.

## Coordinate reference system

Write WGS 84 longitude/latitude (EPSG:4326) or Web Mercator (EPSG:3857); both are read natively. Geographic CRSs on modern datums within about 2 m of WGS 84 (NAD83, ETRS89, GDA94, GDA2020, NZGD2000, SIRGAS 2000, JGD2000/2011) are read as longitude/latitude too. Any other CRS needs a projection on every source (`crs: { toWgs84, fromWgs84 }`), which costs a conversion per vertex and per tile; `crs: 'lonlat'` accepts the offset of another geographic datum instead.

## Low zooms: overview files

At low zooms a tile covers much of the dataset, and every feature in it has to be read, whatever is drawn in the end. Per-tile budgets (`maxReadBytes`, `maxFeatures`) stop such tiles; `pointGrid` thins points in the output but not the reading.

Serve low zooms from a smaller file instead. Sources sharing a layer name are merged into one layer, so the switch is invisible to clients:

```typescript
sources: [
  { name: 'buildings', path: 'buildings-overview.fgb', options: { maxZoom: 11 } },
  { name: 'buildings', path: 'buildings.fgb', options: { minZoom: 12 } },
]
```

Overviews can be made with GDAL, for example:

```sh
# Polygons and lines: simplify (tolerance in degrees)
ogr2ogr -f FlatGeobuf buildings-overview.fgb buildings.fgb -simplify 0.0005
# Points: keep a sample
ogr2ogr -f FlatGeobuf poi-overview.fgb poi.fgb -dialect sqlite -sql "SELECT * FROM poi WHERE abs(random()) % 20 = 0"
```

## Attributes

- An integer column named `id`, `fid`, `gid` or `ogc_fid` becomes the MVT feature id, which renderers need for feature state (hover, selection). Name another column with `idColumn`.
- Columns the map does not use still cost bytes in every tile: drop them when writing, or select per source with `properties`.
- Binary columns are never written to tiles (MVT has no binary values).

## Geometry

- All FlatGeobuf geometry types work. Curves are linearised per tile; collections become one feature per geometry family.
- **Antimeridian:** split geometries crossing ±180° (as GeoJSON, RFC 7946, recommends), or store them with longitudes beyond 180°. A ring that jumps from 179° to -179° looks like a ring around the world and cannot be repaired.
- Z and M values are kept in the file but ignored for tiles.

## Other writers

The flatgeobuf JavaScript and Rust libraries also store features in index order.

**gogama/flatgeobuf (Go), v1.0.0:** do not use `FileWriter.IndexData`. Its index does not match the data it writes:

- leaf offsets leave out the 4-byte size prefix of every preceding feature, so they point into the middle of features;
- features are written in input order, while the index is in Hilbert order;
- feature boxes ignore geometry `parts`, so multipolygons and collections stored as parts get empty boxes and can never be found.

fgb-vt detects such files and raises `IndexMismatchError` (`useIndex: false` scans them instead, within `maxScanBytes`). To write valid files with gogama, build the index yourself and write it with `FileWriter.Index`, then the features in the same order with `FileWriter.Data`:

1. compute each feature's box over all its coordinates, including those in `parts`;
2. sort the features with `packedrtree.HilbertSort`;
3. assign offsets in sorted order, adding `4 + size` for each feature (the size prefix included);
4. build the tree with `packedrtree.New(refs, nodeSize)`.

`test/fixtures/writers/gogama/main.go` (`buildIndex`) does exactly this.

## Checking a file

Tile it at a few zooms with fgb-vt. A file that reads without `IndexMismatchError` or `FormatError` has an index that matches its data in the areas read; `useIndex: false` against the indexed result is a quick cross-check for small files.

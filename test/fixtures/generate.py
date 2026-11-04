#!/usr/bin/env python3
"""
Regenerate the golden FlatGeobuf fixtures in this directory.

The fixtures are written by GDAL (ogr2ogr), an implementation independent of
fgb-vt, so tests exercise real-writer output instead of hand-built buffers.
GDAL omits header fields that equal their schema default (e.g.
index_node_size = 16), which is exactly what readers must handle.

Requires GDAL >= 3.1 with the FlatGeobuf driver and its Python bindings.
Usage: python3 test/fixtures/generate.py
"""

import json
import math
import os
import subprocess
import tempfile

from osgeo import ogr

HERE = os.path.dirname(os.path.abspath(__file__))


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def feature(props, geom):
    return {"type": "Feature", "properties": props, "geometry": geom}


def ring(cx, cy, r, n):
    pts = [[cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)] for i in range(n)]
    pts.append(pts[0])
    return pts


def polygon(cx, cy, r, n=8):
    return {"type": "Polygon", "coordinates": [ring(cx, cy, r, n)]}


def write(name, collection, *lco):
    out = os.path.join(HERE, name)
    if os.path.exists(out):
        os.remove(out)
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.geojson")
        with open(src, "w") as f:
            json.dump(collection, f)
        layer = os.path.splitext(name)[0]
        cmd = ["ogr2ogr", "-f", "FlatGeobuf", out, src, "-nln", layer]
        for opt in lco:
            cmd += ["-lco", opt]
        subprocess.run(cmd, check=True)
    print(f"wrote {name} ({os.path.getsize(out)} bytes)")
    return out


def file_order(path, field):
    """Values of `field` in on-disk (Hilbert-sorted) feature order."""
    ds = ogr.Open(path)
    layer = ds.GetLayer(0)
    return [f.GetField(field) for f in layer]


# 200 points on a grid with 64-bit integer properties.
points = []
for i in range(200):
    points.append(feature(
        {"id": i, "big": 5_000_000_000 + i, "ts": 1_700_000_000_000 + i,
         "neg": -3_000_000_000 - i, "small": i - 100, "ratio": i / 8, "label": f"p{i}"},
        {"type": "Point", "coordinates": [-100 + (i % 20) * 0.5, 30 + (i // 20) * 0.5]},
    ))
write("points.fgb", fc(points))

# A single feature: the packed R-tree has two nodes (root + leaf).
write("single.fgb", fc([feature({"name": "solo", "id": 7}, polygon(10, 10, 1))]))

# The feature stored last in the file is much larger than its predecessor,
# so its length cannot be inferred from the index.
def last_big(big_k):
    feats = []
    for k in range(50):
        n = 2000 if k == big_k else 8
        feats.append(feature({"k": k}, polygon(-120 + k * 0.3, 35, 0.1, n)))
    return fc(feats)

path = write("last-feature.fgb", last_big(-1))
last_k = file_order(path, "k")[-1]
write("last-feature.fgb", last_big(last_k))
assert file_order(path, "k")[-1] == last_k

# Points around the east edge of z10 tile containing (-95, 32), plus ids
# outside the 32-bit and non-negative ranges.
z = 10
n = 2 ** z
x = int((-95 + 180) / 360 * n)
east = (x + 1) / n * 360 - 180
edge = [
    feature({"id": 1, "where": "inside"}, {"type": "Point", "coordinates": [(x + 0.5) / n * 360 - 180, 32.0]}),
    feature({"id": 2, "where": "east-buffer"}, {"type": "Point", "coordinates": [east + 0.002, 32.0]}),
    feature({"id": 3, "where": "outside"}, {"type": "Point", "coordinates": [east + 1.0, 32.0]}),
    feature({"id": 4_294_967_301, "where": "big-id"}, {"type": "Point", "coordinates": [-80, 40]}),
    feature({"id": -5, "where": "negative-id"}, {"type": "Point", "coordinates": [-81, 40]}),
]
write("tile-edge.fgb", fc(edge))

# Detailed (Multi)Polygons: single-part, multi-part and with a hole.
polys = [
    feature({"name": "circle"}, {"type": "MultiPolygon", "coordinates": [[ring(-90, 40, 2, 1500)]]}),
    feature({"name": "pair"}, {"type": "MultiPolygon", "coordinates": [[ring(-80, 40, 1, 800)], [ring(-76, 40, 1, 800)]]}),
    feature({"name": "donut"}, {"type": "MultiPolygon", "coordinates": [[ring(-70, 40, 2, 1200), ring(-70, 40, 1, 600)[::-1]]]}),
]
write("multipolygons.fgb", fc(polys))

# Lines: LineString, single-part and two-part MultiLineString.
def wave(x0, y0, n):
    return [[x0 + i * 0.01, y0 + 0.2 * math.sin(i / 20)] for i in range(n)]

lines = [
    feature({"name": "line"}, {"type": "LineString", "coordinates": wave(-100, 45, 1000)}),
    feature({"name": "multi-1"}, {"type": "MultiLineString", "coordinates": [wave(-100, 44, 1000)]}),
    feature({"name": "multi-2"}, {"type": "MultiLineString", "coordinates": [wave(-100, 43, 500), wave(-94, 43, 500)]}),
]
write("lines.fgb", fc(lines))

# 5,000 points on a jittered grid: a five-level packed R-tree (node size 16)
# for index search, containment and paging tests.
import random
rng = random.Random(42)
grid = []
for i in range(5000):
    lon = -125 + (i % 100) * 0.58 + rng.uniform(-0.2, 0.2)
    lat = 25 + (i // 100) * 0.48 + rng.uniform(-0.2, 0.2)
    grid.append(feature({"id": i}, {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}))
write("grid-5k.fgb", fc(grid))

# The same 200 points as points.fgb, written without a spatial index.
write("no-index.fgb", fc(points), "SPATIAL_INDEX=NO")


# == Extended geometry types, dimensions and CRSs ===========================
# GeoJSON cannot carry curves, surfaces or measures, so these are written
# through the OGR API from WKT.

ogr.UseExceptions()


def write_wkt(name, geom_type, rows, epsg=4326):
    """Write `rows` of (properties, WKT) to a FlatGeobuf layer of `geom_type`."""
    from osgeo import osr
    out = os.path.join(HERE, name)
    if os.path.exists(out):
        os.remove(out)
    srs = None
    if epsg is not None:
        srs = osr.SpatialReference()
        srs.ImportFromEPSG(epsg)
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ds = ogr.GetDriverByName("FlatGeobuf").CreateDataSource(out)
    layer = ds.CreateLayer(os.path.splitext(name)[0], srs, geom_type)
    for key, value in rows[0][0].items():
        layer.CreateField(ogr.FieldDefn(key, ogr.OFTInteger if isinstance(value, int) else ogr.OFTString))
    for props, wkt in rows:
        f = ogr.Feature(layer.GetLayerDefn())
        for key, value in props.items():
            f.SetField(key, value)
        f.SetGeometry(ogr.CreateGeometryFromWkt(wkt))
        layer.CreateFeature(f)
    ds = None
    print(f"wrote {name} ({os.path.getsize(out)} bytes)")
    return out


# Curves in a mixed layer (header geometry type Unknown, per-feature types).
write_wkt("curves.fgb", ogr.wkbUnknown, [
    ({"id": 1, "kind": "arc"}, "CIRCULARSTRING(-101 40, -100 41, -99 40)"),
    ({"id": 2, "kind": "compound"}, "COMPOUNDCURVE((-103 38, -102 38), CIRCULARSTRING(-102 38, -101 39, -100 38))"),
    ({"id": 3, "kind": "disc"},
     "CURVEPOLYGON(CIRCULARSTRING(-96 40, -94 40, -96 40), (-95.5 40, -95 40.5, -94.5 40, -95.5 40))"),
    ({"id": 4, "kind": "half-disc"},
     "CURVEPOLYGON(COMPOUNDCURVE(CIRCULARSTRING(-91 40, -90 41, -89 40), (-89 40, -91 40)))"),
    ({"id": 5, "kind": "multicurve"}, "MULTICURVE((-100 35, -99 35), CIRCULARSTRING(-98 35, -97 36, -96 35))"),
    ({"id": 6, "kind": "multisurface"},
     "MULTISURFACE(((-100 30, -99 30, -99 31, -100 30)), CURVEPOLYGON(CIRCULARSTRING(-97 30, -95 30, -97 30)))"),
])

# A typed CurvePolygon layer: parts may rely on the header type.
write_wkt("curvepolygons.fgb", ogr.wkbCurvePolygon, [
    ({"id": 1}, "CURVEPOLYGON(CIRCULARSTRING(-101 40, -99 40, -101 40))"),
    ({"id": 2}, "CURVEPOLYGON(CIRCULARSTRING(-91 40, -89 40, -91 40))"),
])

# Surfaces: TIN, PolyhedralSurface and Triangle in a mixed layer, and a
# typed 3D TIN.
write_wkt("surfaces.fgb", ogr.wkbUnknown, [
    ({"id": 1, "kind": "tin"}, "TIN(((-101 40, -100 40, -101 41, -101 40)), ((-100 40, -100 41, -101 41, -100 40)))"),
    ({"id": 2, "kind": "polyhedral"},
     "POLYHEDRALSURFACE(((-96 40, -95 40, -95 41, -96 40)), ((-96 40, -96 41, -95 41, -96 40)))"),
    ({"id": 3, "kind": "triangle"}, "TRIANGLE((-91 40, -90 40, -91 41, -91 40))"),
])
write_wkt("tin-z.fgb", ogr.wkbTINZ, [
    ({"id": 1}, "TIN Z(((-101 40 1, -100 40 2, -101 41 3, -101 40 1)), ((-100 40 2, -100 41 4, -101 41 3, -100 40 2)))"),
])

# Geometry collections, including nested multi-geometries and curves.
write_wkt("collections.fgb", ogr.wkbGeometryCollection, [
    ({"id": 1, "kind": "mixed"},
     "GEOMETRYCOLLECTION(POINT(-100 40), LINESTRING(-101 39, -99 39), POLYGON((-101 41, -99 41, -100 42, -101 41)))"),
    ({"id": 2, "kind": "nested"},
     "GEOMETRYCOLLECTION(MULTIPOLYGON(((-95 40, -94 40, -94 41, -95 40)), ((-93 40, -92 40, -92 41, -93 40))), "
     "MULTIPOINT((-95 39), (-94 39)), CIRCULARSTRING(-95 38, -94 39, -93 38))"),
    ({"id": 3, "kind": "points"}, "GEOMETRYCOLLECTION(POINT(-90 40), POINT(-89 40))"),
])

# Basic types in a mixed layer (header Unknown, per-feature types).
write_wkt("mixed.fgb", ogr.wkbUnknown, [
    ({"id": 1, "kind": "point"}, "POINT(-100 40)"),
    ({"id": 2, "kind": "line"}, "LINESTRING(-101 39, -99 39)"),
    ({"id": 3, "kind": "polygon"}, "POLYGON((-101 41, -99 41, -100 42, -101 41))"),
    ({"id": 4, "kind": "multipoint"}, "MULTIPOINT((-95 39), (-94 39))"),
    ({"id": 5, "kind": "multiline"}, "MULTILINESTRING((-95 38, -94 38), (-93 38, -92 38))"),
    ({"id": 6, "kind": "multipolygon"}, "MULTIPOLYGON(((-95 40, -94 40, -94 41, -95 40)), ((-93 40, -92 40, -92 41, -93 40)))"),
])

# The same geometries with XY, XYZ, XYM and XYZM coordinates.
DIMS = [("xy", "", 0, 0), ("xyz", " Z", 1, 0), ("xym", " M", 0, 1), ("xyzm", " ZM", 1, 1)]
for suffix, tag, has_z, has_m in DIMS:
    def c(x, y):
        return f"{x} {y}" + (" 7" if has_z else "") + (" 9" if has_m else "")
    write_wkt(f"dims-{suffix}.fgb", ogr.GT_SetModifier(ogr.wkbUnknown, has_z, has_m), [
        ({"id": 1}, f"POINT{tag}({c(-100, 40)})"),
        ({"id": 2}, f"LINESTRING{tag}({c(-101, 39)}, {c(-100, 39.5)}, {c(-99, 39)})"),
        ({"id": 3}, f"POLYGON{tag}(({c(-96, 39)}, {c(-94, 39)}, {c(-94, 41)}, {c(-96, 41)}, {c(-96, 39)}), "
                    f"({c(-95.5, 39.5)}, {c(-95.5, 40.5)}, {c(-94.5, 40.5)}, {c(-94.5, 39.5)}, {c(-95.5, 39.5)}))"),
    ])

# points.fgb in Web Mercator and in World Equidistant Cylindrical (a CRS
# that needs a projection hook; its math is x = R·lon, y = R·lat).
for epsg in (3857, 4087):
    out = os.path.join(HERE, f"points-{epsg}.fgb")
    if os.path.exists(out):
        os.remove(out)
    subprocess.run(["ogr2ogr", "-f", "FlatGeobuf", out, os.path.join(HERE, "points.fgb"),
                    "-t_srs", f"EPSG:{epsg}", "-nln", f"points-{epsg}"], check=True)
    print(f"wrote points-{epsg}.fgb ({os.path.getsize(out)} bytes)")

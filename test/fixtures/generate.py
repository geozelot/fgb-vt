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

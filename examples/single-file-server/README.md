# Minimal `fgb-vt` Tile Server Demo

Interactive map demo serving a single _FlatGeobuf_ as _Vector Tiles_ via all three API tiers
- `TileServer`
- `TileClient`
- `tile()`

side by side, across all three connectors
- `LocalConnector`
- `HttpConnector`
- `S3Connector`

>_`S3Connector` is a mock-up interceptor and re-routes calls to the local call site via simulated `GetObject` requests and `Range` headers - to enable testing without credentials._

---

  |     Data Source | `data/us_counties.fgb` |
  |----------------:|:-----------------------|
  |            Size | 14.1 MB                |
  |   Feature Count | 3221                   |
  | Property Fields | 6                      |
  |   Geometry Type | `MultiPolygon`         |
  |             CRS | `EPSG:4269 - NAD83`    |


## Run

```bash
npm install
npm start
# → http://localhost:3000
```

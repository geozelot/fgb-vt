// Command gogama writes FlatGeobuf fixtures with github.com/gogama/flatgeobuf,
// a writer independent of GDAL, for interoperability tests.
//
// gogama v1.0.0's FileWriter.IndexData produces an index that does not
// match the data: leaf offsets leave out the 4-byte size prefix of every
// preceding feature, features are written in input rather than index
// order, and feature boxes ignore geometry parts. The gogama-indexdata-*
// fixtures keep that output to test that readers detect it. The other
// indexed fixtures build the index here (Hilbert-sorted features, offsets
// including size prefixes, boxes over all parts) and write it with
// FileWriter.Index, which is the way to produce valid files with gogama.
//
// Usage (from this directory): go run . ../..
package main

import (
	"bytes"
	"fmt"
	"math"
	"os"
	"path/filepath"

	"github.com/gogama/flatgeobuf/flatgeobuf"
	"github.com/gogama/flatgeobuf/flatgeobuf/flat"
	"github.com/gogama/flatgeobuf/packedrtree"
	flatbuffers "github.com/google/flatbuffers/go"
)

type column struct {
	name string
	typ  flat.ColumnType
}

var columns = []column{
	{"id", flat.ColumnTypeInt},
	{"label", flat.ColumnTypeString},
	{"ratio", flat.ColumnTypeDouble},
	{"flag", flat.ColumnTypeBool},
	{"small", flat.ColumnTypeShort},
	{"big", flat.ColumnTypeLong},
}

// geometry is one feature geometry in FlatGeobuf's flat layout: either xy
// with optional ends, or parts.
type geometry struct {
	typ   flat.GeometryType
	xy    []float64
	ends  []uint32
	parts []geometry
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: gogama <output directory>")
		os.Exit(2)
	}
	out := os.Args[1]

	// The 200 points of points.fgb (GDAL), with gogama's column types
	var points []geometry
	for i := 0; i < 200; i++ {
		x := -100 + float64(i%20)*0.5
		y := 30 + float64(i/20)*0.5
		points = append(points, geometry{typ: flat.GeometryTypePoint, xy: []float64{x, y}})
	}
	write(filepath.Join(out, "gogama-points.fgb"), flat.GeometryTypePoint, points, 4, false)
	write(filepath.Join(out, "gogama-points-noindex.fgb"), flat.GeometryTypePoint, points, 0, false)
	write(filepath.Join(out, "gogama-indexdata-points.fgb"), flat.GeometryTypePoint, points, 16, true)

	// Polygons with holes and multipolygons stored as parts
	var polygons []geometry
	for i := 0; i < 30; i++ {
		cx := -120 + float64(i%6)*8
		cy := 30 + float64(i/6)*4
		outer := ring(cx, cy, 1.5, 40, false)
		hole := ring(cx, cy, 0.5, 12, true)
		poly := geometry{typ: flat.GeometryTypePolygon, xy: append(outer, hole...), ends: []uint32{41, 54}}
		if i%3 == 0 {
			second := geometry{typ: flat.GeometryTypePolygon, xy: ring(cx+3, cy, 0.7, 20, false)}
			polygons = append(polygons, geometry{typ: flat.GeometryTypeMultiPolygon, parts: []geometry{poly, second}})
		} else {
			polygons = append(polygons, geometry{typ: flat.GeometryTypeMultiPolygon, parts: []geometry{poly}})
		}
	}
	write(filepath.Join(out, "gogama-polygons.fgb"), flat.GeometryTypeMultiPolygon, polygons, 16, false)
	write(filepath.Join(out, "gogama-indexdata-polygons.fgb"), flat.GeometryTypeMultiPolygon, polygons, 16, true)
}

// buildIndex sorts features into Hilbert order and builds the packed R-tree
// over them, with byte offsets that include each feature's size prefix.
func buildIndex(geoms []geometry, features []flat.Feature, nodeSize uint16) (*packedrtree.PackedRTree, []flat.Feature) {
	refs := make([]packedrtree.Ref, len(geoms))
	bounds := packedrtree.EmptyBox
	for i, g := range geoms {
		refs[i].Box = packedrtree.EmptyBox
		expand(&refs[i].Box, g)
		refs[i].Offset = int64(i) // original position, replaced below
		bounds.Expand(&refs[i].Box)
	}
	packedrtree.HilbertSort(refs, bounds)
	sorted := make([]flat.Feature, len(features))
	var offset int64
	for i := range refs {
		sorted[i] = features[refs[i].Offset]
		refs[i].Offset = offset
		offset += 4 + int64(flatbuffers.GetUint32(sorted[i].Table().Bytes))
	}
	index, err := packedrtree.New(refs, nodeSize)
	check(err)
	return index, sorted
}

// expand grows b by every coordinate of g, including its parts.
func expand(b *packedrtree.Box, g geometry) {
	for i := 0; i < len(g.xy); i += 2 {
		b.ExpandXY(g.xy[i], g.xy[i+1])
	}
	for _, p := range g.parts {
		expand(b, p)
	}
}

// ring returns a closed circle approximation, counter-clockwise unless reversed.
func ring(cx, cy, r float64, n int, reverse bool) []float64 {
	xy := make([]float64, 0, 2*(n+1))
	for k := 0; k <= n; k++ {
		a := 2 * math.Pi * float64(k%n) / float64(n)
		if reverse {
			a = -a
		}
		xy = append(xy, cx+r*math.Cos(a), cy+r*math.Sin(a))
	}
	return xy
}

func write(path string, typ flat.GeometryType, geoms []geometry, nodeSize uint16, useIndexData bool) {
	f, err := os.Create(path)
	check(err)
	defer f.Close()
	w := flatgeobuf.NewFileWriter(f)
	_, err = w.Header(header(typ, len(geoms), nodeSize, geoms))
	check(err)
	features := make([]flat.Feature, len(geoms))
	for i, g := range geoms {
		features[i] = *feature(i, g)
	}
	switch {
	case nodeSize == 0:
		_, err = w.Data(features)
	case useIndexData:
		_, err = w.IndexData(features)
	default:
		var index *packedrtree.PackedRTree
		index, features = buildIndex(geoms, features, nodeSize)
		if _, err = w.Index(index); err == nil {
			_, err = w.Data(features)
		}
	}
	check(err)
	check(w.Close())
	info, err := os.Stat(path)
	check(err)
	fmt.Printf("wrote %s (%d bytes)\n", filepath.Base(path), info.Size())
}

func header(typ flat.GeometryType, count int, nodeSize uint16, geoms []geometry) *flat.Header {
	b := flatbuffers.NewBuilder(0)
	name := b.CreateString("gogama")
	cols := make([]flatbuffers.UOffsetT, len(columns))
	for i, c := range columns {
		n := b.CreateString(c.name)
		flat.ColumnStart(b)
		flat.ColumnAddName(b, n)
		flat.ColumnAddType(b, c.typ)
		cols[i] = flat.ColumnEnd(b)
	}
	flat.HeaderStartColumnsVector(b, len(cols))
	for i := len(cols) - 1; i >= 0; i-- {
		b.PrependUOffsetT(cols[i])
	}
	colVec := b.EndVector(len(cols))

	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	var visit func(g geometry)
	visit = func(g geometry) {
		for i := 0; i < len(g.xy); i += 2 {
			minX, maxX = math.Min(minX, g.xy[i]), math.Max(maxX, g.xy[i])
			minY, maxY = math.Min(minY, g.xy[i+1]), math.Max(maxY, g.xy[i+1])
		}
		for _, p := range g.parts {
			visit(p)
		}
	}
	for _, g := range geoms {
		visit(g)
	}
	flat.HeaderStartEnvelopeVector(b, 4)
	for _, v := range []float64{maxY, maxX, minY, minX} {
		b.PrependFloat64(v)
	}
	env := b.EndVector(4)

	org := b.CreateString("EPSG")
	flat.CrsStart(b)
	flat.CrsAddOrg(b, org)
	flat.CrsAddCode(b, 4326)
	crs := flat.CrsEnd(b)

	flat.HeaderStart(b)
	flat.HeaderAddName(b, name)
	flat.HeaderAddEnvelope(b, env)
	flat.HeaderAddGeometryType(b, typ)
	flat.HeaderAddColumns(b, colVec)
	flat.HeaderAddFeaturesCount(b, uint64(count))
	flat.HeaderAddIndexNodeSize(b, nodeSize)
	flat.HeaderAddCrs(b, crs)
	flat.FinishSizePrefixedHeaderBuffer(b, flat.HeaderEnd(b))
	return flat.GetSizePrefixedRootAsHeader(b.FinishedBytes(), 0)
}

func feature(i int, g geometry) *flat.Feature {
	var props bytes.Buffer
	pw := flatgeobuf.NewPropWriter(&props)
	pw.WriteUShort(0)
	pw.WriteInt(int32(i))
	pw.WriteUShort(1)
	pw.WriteString(fmt.Sprintf("p%d", i))
	pw.WriteUShort(2)
	pw.WriteDouble(float64(i) / 8)
	pw.WriteUShort(3)
	pw.WriteBool(i%2 == 0)
	pw.WriteUShort(4)
	pw.WriteShort(int16(i - 100))
	pw.WriteUShort(5)
	pw.WriteLong(5_000_000_000 + int64(i))

	b := flatbuffers.NewBuilder(0)
	propVec := b.CreateByteVector(props.Bytes())
	geom := buildGeometry(b, g)
	flat.FeatureStart(b)
	flat.FeatureAddGeometry(b, geom)
	flat.FeatureAddProperties(b, propVec)
	flat.FinishSizePrefixedFeatureBuffer(b, flat.FeatureEnd(b))
	return flat.GetSizePrefixedRootAsFeature(b.FinishedBytes(), 0)
}

func buildGeometry(b *flatbuffers.Builder, g geometry) flatbuffers.UOffsetT {
	var parts flatbuffers.UOffsetT
	if len(g.parts) > 0 {
		offsets := make([]flatbuffers.UOffsetT, len(g.parts))
		for i, p := range g.parts {
			offsets[i] = buildGeometry(b, p)
		}
		flat.GeometryStartPartsVector(b, len(offsets))
		for i := len(offsets) - 1; i >= 0; i-- {
			b.PrependUOffsetT(offsets[i])
		}
		parts = b.EndVector(len(offsets))
	}
	var xy, ends flatbuffers.UOffsetT
	if len(g.xy) > 0 {
		flat.GeometryStartXyVector(b, len(g.xy))
		for i := len(g.xy) - 1; i >= 0; i-- {
			b.PrependFloat64(g.xy[i])
		}
		xy = b.EndVector(len(g.xy))
	}
	if len(g.ends) > 0 {
		flat.GeometryStartEndsVector(b, len(g.ends))
		for i := len(g.ends) - 1; i >= 0; i-- {
			b.PrependUint32(g.ends[i])
		}
		ends = b.EndVector(len(g.ends))
	}
	flat.GeometryStart(b)
	if parts != 0 {
		flat.GeometryAddParts(b, parts)
	}
	if xy != 0 {
		flat.GeometryAddXy(b, xy)
	}
	if ends != 0 {
		flat.GeometryAddEnds(b, ends)
	}
	flat.GeometryAddType(b, g.typ)
	return flat.GeometryEnd(b)
}

func check(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

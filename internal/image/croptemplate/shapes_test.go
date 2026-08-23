package croptemplate

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

// As in psd_test.go, everything the format dictates is written out as a literal
// rather than taken from the constants in shapes.go: the 26-byte record, the
// 8.24 divisor, the selectors, the keys. A fixture built from the constant it
// is meant to be checking agrees with any value of it, and getting one of these
// numbers wrong is the mutation that matters most.

// fixed24 encodes a canvas fraction as the signed 8.24 fixed point a path
// coordinate is stored in.
func fixed24(v float64) uint32 { return uint32(int32(v * (1 << 24))) }

// pathPoint writes one coordinate pair: vertical first, then horizontal, which
// is the opposite of every other coordinate in the format.
func pathPoint(x, y float64) []byte {
	var b []byte
	b = binary.BigEndian.AppendUint32(b, fixed24(y))
	b = binary.BigEndian.AppendUint32(b, fixed24(x))
	return b
}

// pathRecord is always 26 bytes: a two-byte selector and twenty-four of
// payload, whatever the selector means.
func pathRecord(selector uint16, payload []byte) []byte {
	b := binary.BigEndian.AppendUint16(nil, selector)
	b = append(b, payload...)
	if len(payload) < 24 {
		b = append(b, make([]byte, 24-len(payload))...)
	}
	return b[:26]
}

type testKnot struct {
	inX, inY         float64
	anchorX, anchorY float64
	outX, outY       float64
}

// corner is a knot whose controls sit on its anchor, which is how Photoshop
// stores a straight corner. A rectangle is four of these.
func corner(x, y float64) testKnot {
	return testKnot{inX: x, inY: y, anchorX: x, anchorY: y, outX: x, outY: y}
}

func knotRecord(selector uint16, k testKnot) []byte {
	var payload []byte
	payload = append(payload, pathPoint(k.inX, k.inY)...)
	payload = append(payload, pathPoint(k.anchorX, k.anchorY)...)
	payload = append(payload, pathPoint(k.outX, k.outY)...)
	return pathRecord(selector, payload)
}

// vectorMask builds a vsms payload: a version, flags, a subpath length record
// and then the knots.
func vectorMask(closed bool, knots []testKnot) []byte {
	lengthSelector, knotSelector := uint16(0), uint16(1)
	if !closed {
		lengthSelector, knotSelector = 3, 4
	}

	b := binary.BigEndian.AppendUint32(nil, 3) // version
	b = binary.BigEndian.AppendUint32(b, 0)    // flags

	b = append(b, pathRecord(lengthSelector,
		binary.BigEndian.AppendUint16(nil, uint16(len(knots))))...)
	for _, k := range knots {
		b = append(b, knotRecord(knotSelector, k)...)
	}
	return b
}

// additionalBlock wraps a payload with the 8BIM signature and a four-character
// key, padded to an even length.
func additionalBlock(key string, data []byte) []byte {
	b := append([]byte("8BIM"), key...)
	b = binary.BigEndian.AppendUint32(b, uint32(len(data)))
	b = append(b, data...)
	if len(data)%2 != 0 {
		b = append(b, 0)
	}
	return b
}

// unicodeName builds a luni payload: a character count, then UTF-16.
func unicodeName(name string) []byte {
	runes := []rune(name)
	b := binary.BigEndian.AppendUint32(nil, uint32(len(runes)))
	for _, r := range runes {
		b = binary.BigEndian.AppendUint16(b, uint16(r))
	}
	return b
}

type testLayer struct {
	name       string
	unicode    string
	hidden     bool
	vectorMask []byte
}

func layerRecord(l testLayer) []byte {
	var extra []byte
	extra = binary.BigEndian.AppendUint32(extra, 0) // layer mask data, empty
	extra = binary.BigEndian.AppendUint32(extra, 0) // blending ranges, empty

	// The legacy name is a Pascal string padded so it and its length byte
	// occupy a multiple of four -- four here, not two as elsewhere.
	extra = append(extra, byte(len(l.name)))
	extra = append(extra, l.name...)
	if pad := (len(l.name) + 1) % 4; pad != 0 {
		extra = append(extra, make([]byte, 4-pad)...)
	}

	if l.unicode != "" {
		extra = append(extra, additionalBlock("luni", unicodeName(l.unicode))...)
	}
	if l.vectorMask != nil {
		extra = append(extra, additionalBlock("vsms", l.vectorMask)...)
	}

	var b []byte
	b = append(b, make([]byte, 16)...)      // bounds
	b = binary.BigEndian.AppendUint16(b, 0) // channel count
	b = append(b, "8BIM"...)
	b = append(b, "norm"...)
	b = append(b, 255) // opacity
	b = append(b, 0)   // clipping
	if l.hidden {
		b = append(b, 2)
	} else {
		b = append(b, 0)
	}
	b = append(b, 0) // filler
	b = binary.BigEndian.AppendUint32(b, uint32(len(extra)))
	b = append(b, extra...)
	return b
}

// buildPSDWithSection is buildPSD with a layer and mask section attached.
func buildPSDWithSection(width, height int, resources, section []byte) []byte {
	var b []byte
	b = append(b, "8BPS"...)
	b = binary.BigEndian.AppendUint16(b, 1)
	b = append(b, make([]byte, 6)...)
	b = binary.BigEndian.AppendUint16(b, 3)
	b = binary.BigEndian.AppendUint32(b, uint32(height))
	b = binary.BigEndian.AppendUint32(b, uint32(width))
	b = binary.BigEndian.AppendUint16(b, 8)
	b = binary.BigEndian.AppendUint16(b, 3)
	b = binary.BigEndian.AppendUint32(b, 0)
	b = binary.BigEndian.AppendUint32(b, uint32(len(resources)))
	b = append(b, resources...)

	b = binary.BigEndian.AppendUint32(b, uint32(len(section)))
	b = append(b, section...)
	b = append(b, 0, 0)
	return b
}

// shapePSD assembles a file whose only content is the given layers.
func shapePSD(layers ...testLayer) []byte {
	info := binary.BigEndian.AppendUint16(nil, uint16(len(layers)))
	for _, l := range layers {
		info = append(info, layerRecord(l)...)
	}

	// The layer info sub-section carries its own length before the count.
	section := binary.BigEndian.AppendUint32(nil, uint32(len(info)))
	section = append(section, info...)

	return buildPSDWithSection(800, 1200, nil, section)
}

// An ellipse as Photoshop stores one: four knots, controls off to the sides.
func ellipseKnots() []testKnot {
	return []testKnot{
		{inX: 0.28, inY: 0.02, anchorX: 0.5, anchorY: 0.02, outX: 0.72, outY: 0.02},
		{inX: 0.9, inY: 0.19, anchorX: 0.9, anchorY: 0.4, outX: 0.9, outY: 0.6},
		{inX: 0.72, inY: 0.77, anchorX: 0.5, anchorY: 0.77, outX: 0.28, outY: 0.77},
		{inX: 0.09, inY: 0.6, anchorX: 0.09, anchorY: 0.4, outX: 0.09, outY: 0.19},
	}
}

func closeTo(t *testing.T, got, want float64, what string) {
	t.Helper()
	// A tolerance because 8.24 fixed point cannot hold most fractions exactly.
	if math.Abs(got-want) > 1e-6 {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}

func TestParseReadsShapeOutlines(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "head guide",
		vectorMask: vectorMask(true, ellipseKnots()),
	}))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	if len(template.Shapes) != 1 {
		t.Fatalf("got %d shapes, want 1", len(template.Shapes))
	}
	shape := template.Shapes[0]

	if shape.Label != "head guide" {
		t.Errorf("label %q, want %q", shape.Label, "head guide")
	}
	if len(shape.Subpaths) != 1 {
		t.Fatalf("got %d subpaths, want 1", len(shape.Subpaths))
	}
	if !shape.Subpaths[0].Closed {
		t.Error("subpath should be closed")
	}
	if got := len(shape.Subpaths[0].Knots); got != 4 {
		t.Fatalf("got %d knots, want 4", got)
	}
}

// The coordinate order is the easiest thing in this format to get quietly
// wrong: swapping the pair still parses and still draws a shape, just the wrong
// one. An asymmetric point is the only kind that can tell.
func TestParseReadsPointsVerticalFirst(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "lopsided",
		vectorMask: vectorMask(true, []testKnot{corner(0.25, 0.75), corner(0.5, 0.5)}),
	}))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	anchor := template.Shapes[0].Subpaths[0].Knots[0].Anchor
	closeTo(t, anchor.X, 0.25, "anchor x")
	closeTo(t, anchor.Y, 0.75, "anchor y")
}

func TestParseKeepsControlPointsWithTheirAnchor(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "curve",
		vectorMask: vectorMask(true, ellipseKnots()),
	}))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	top := template.Shapes[0].Subpaths[0].Knots[0]
	closeTo(t, top.Anchor.X, 0.5, "anchor x")
	closeTo(t, top.In.X, 0.28, "incoming control x")
	closeTo(t, top.Out.X, 0.72, "outgoing control x")
}

// Points may sit outside the canvas: a crop box is usually drawn a hair
// outside it so its stroke does not eat into the picture. Clamping them would
// move the very lines a template exists to place.
func TestParseKeepsPointsOutsideTheCanvas(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "crop box",
		vectorMask: vectorMask(true, []testKnot{corner(-0.01, -0.02), corner(1.01, 1.02)}),
	}))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	first := template.Shapes[0].Subpaths[0].Knots[0].Anchor
	closeTo(t, first.X, -0.01, "negative x")
	closeTo(t, first.Y, -0.02, "negative y")
}

func TestParseDistinguishesOpenSubpaths(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "arc",
		vectorMask: vectorMask(false, []testKnot{corner(0, 0), corner(1, 1)}),
	}))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	if template.Shapes[0].Subpaths[0].Closed {
		t.Error("an open subpath should not come back closed")
	}
}

// A designer hides working geometry -- construction lines, alternates -- and
// drawing it over a contributor's photograph would show them something the
// template's author chose not to.
func TestParseSkipsHiddenLayers(t *testing.T) {
	template, err := Parse(shapePSD(
		testLayer{name: "shown", vectorMask: vectorMask(true, ellipseKnots())},
		testLayer{name: "working", hidden: true, vectorMask: vectorMask(true, ellipseKnots())},
	))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	if len(template.Shapes) != 1 {
		t.Fatalf("got %d shapes, want 1", len(template.Shapes))
	}
	if template.Shapes[0].Label != "shown" {
		t.Errorf("kept %q, want the visible layer", template.Shapes[0].Label)
	}
}

// Most layers in a real template hold no outline at all, and that is not a
// failure -- it is a background, a text layer, a group divider.
func TestParseIgnoresLayersWithoutOutlines(t *testing.T) {
	template, err := Parse(shapePSD(
		testLayer{name: "Background"},
		testLayer{name: "oval", vectorMask: vectorMask(true, ellipseKnots())},
		testLayer{name: "Text"},
	))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	if len(template.Shapes) != 1 {
		t.Fatalf("got %d shapes, want 1", len(template.Shapes))
	}
}

// The Pascal name is legacy, single-byte and lossy. Photoshop writes both, and
// a template named in anything but ASCII is only correct in the Unicode one.
func TestParsePrefersTheUnicodeLayerName(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "tete",
		unicode:    "tête",
		vectorMask: vectorMask(true, ellipseKnots()),
	}))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	if got := template.Shapes[0].Label; got != "tête" {
		t.Errorf("label %q, want %q", got, "tête")
	}
}

// A template whose whole content is an oval has no ruler guides at all, and
// refusing it would be refusing the shape feature outright.
func TestParseAcceptsATemplateWithOnlyShapes(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "head guide",
		vectorMask: vectorMask(true, ellipseKnots()),
	}))
	if err != nil {
		t.Fatalf("a template with shapes and no guides should parse: %v", err)
	}
	if len(template.Guides) != 0 {
		t.Errorf("got %d guides, want none", len(template.Guides))
	}
	if len(template.Shapes) == 0 {
		t.Error("shapes should have been read")
	}
}

// Neither kind of geometry is still nothing to draw.
func TestParseStillReportsATemplateWithNeither(t *testing.T) {
	_, err := Parse(shapePSD(testLayer{name: "Background"}))
	if !errors.Is(err, ErrNoGuides) {
		t.Errorf("got %v, want ErrNoGuides", err)
	}
}

// A subpath declared and then left empty is nothing to draw, and emitting it
// would put a stroke cap on the picture like a speck of dust on the lens.
func TestParseIgnoresEmptySubpaths(t *testing.T) {
	_, err := Parse(shapePSD(testLayer{
		name:       "empty outline",
		vectorMask: vectorMask(true, nil),
	}))
	if !errors.Is(err, ErrNoGuides) {
		t.Errorf("got %v, want ErrNoGuides: an empty subpath is not a shape", err)
	}
}

// bar builds the hairline rectangle a designer draws when marking a line on a
// shape layer rather than dragging one off a ruler.
func bar(axis Axis, position, thickness float64) []testKnot {
	if axis == AxisY {
		return []testKnot{
			corner(0, position-thickness/2), corner(1, position-thickness/2),
			corner(1, position+thickness/2), corner(0, position+thickness/2),
		}
	}
	return []testKnot{
		corner(position-thickness/2, 0), corner(position-thickness/2, 1),
		corner(position+thickness/2, 1), corner(position+thickness/2, 0),
	}
}

// A bar spanning the picture is a line in intent, and this deliberately does
// not read it as one.
//
// Only a ruler guide carries a role and a label, and no measurement recovers
// them: across the shipped templates the margin convention sits at 0.015 and
// the topmost anchor at 0.010, so a threshold placed to tell those apart puts
// 44 of the 47 roled guides in the wrong category, and REFERENCE has no bar
// form at all. Converting where the answer is known -- in whoever prepares the
// template -- is the only version of this that can be right.
func TestParseLeavesBarsAsShapes(t *testing.T) {
	template, err := Parse(shapePSD(testLayer{
		name:       "eyes",
		vectorMask: vectorMask(true, bar(AxisY, 0.425, 0.0008)),
	}))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}

	if len(template.Guides) != 0 {
		t.Errorf("got %d guides, want none: a bar is an outline like any other",
			len(template.Guides))
	}
	if len(template.Shapes) != 1 {
		t.Fatalf("got %d shapes, want 1", len(template.Shapes))
	}
	if template.Shapes[0].Label != "eyes" {
		t.Errorf("got label %q, want %q", template.Shapes[0].Label, "eyes")
	}
}

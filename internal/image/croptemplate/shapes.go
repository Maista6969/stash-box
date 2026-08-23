package croptemplate

// Point is a position on the canvas, as fractions of its width and height.
//
// Fractions all the way through, like guide positions, because a template is
// drawn at one size and rendered at every other. Photoshop already stores path
// points this way, so nothing has to be divided by the canvas on the way in.
type Point struct {
	X float64
	Y float64
}

// Knot is one anchor of a path with the control points either side of it.
//
// Every segment is a cubic curve, including the straight ones -- Photoshop
// draws a straight edge as a curve whose controls sit on top of its anchors,
// and a rectangle and an ellipse come through here in exactly the same shape.
// Nothing tries to recover "this was an ellipse" from the knots: four cubics
// are what an ellipse is in this format, and an SVG path draws them directly.
type Knot struct {
	In     Point
	Anchor Point
	Out    Point
}

// Subpath is one continuous run of knots.
type Subpath struct {
	Closed bool
	Knots  []Knot
}

// Shape is one outline drawn in a template: an oval for a face to sit inside,
// a bar marking a margin, anything a designer can draw with the shape tool.
//
// Guidance, never a constraint. The crop is still a rectangle and the server
// still cuts one; a shape says where to put the subject within it.
type Shape struct {
	// Label is the layer's name in the template. Photoshop puts it right there
	// and a designer naming a layer "head guide" has already said what it is,
	// so there is nothing to annotate separately.
	Label    string
	Subpaths []Subpath
}

// Additional layer information keys, from "Additional Layer Information" in
// the spec: "Vector mask setting" (vmsk) and "Vector Stroke Data" (vsms).
//
// Photoshop writes vsms for a shape layer's outline and vmsk for a plain
// vector mask. Despite the names, both carry the same payload -- a path
// resource, read by parsePath below -- and a file can carry either.
const (
	keyVectorMaskShape = "vsms"
	keyVectorMask      = "vmsk"
)

// The vector-mask payload reuses the record layout of "Path resource format"
// in the Adobe Photoshop File Formats Specification -- the section documents
// the document-level path resources, but "Vector mask setting" defers to it
// for the records. See the reference at the top of psd.go's constants.
const (
	// "Photoshop stores the path information in a series of 26-byte path point
	// records": a two-byte selector and twenty-four bytes of payload, whatever
	// the selector turns out to mean.
	pathRecordLen = 26

	// The same section: knot coordinates are 8.24 fixed point, so a whole unit
	// is 1 << 24.
	fixedPointOne = 1 << 24

	// The selector values, in the order the spec lists them. 6, 7 and 8 are
	// fill rule and clipboard records, which say nothing about where a line
	// goes and are skipped by the switch that reads these.
	selClosedLength   = 0
	selClosedLinked   = 1
	selClosedUnlinked = 2
	selOpenLength     = 3
	selOpenLinked     = 4
	selOpenUnlinked   = 5
)

// collectShapes reads the outlines out of a layer tree, in document order.
//
// Best-effort by design: a layer holding something unfamiliar is skipped rather
// than failing the template. The layer section is by far the largest and most
// variable part of a PSD -- adjustment layers, smart objects, effects, text --
// and only the vector outlines in it are of any interest here. Refusing a
// template whose thirtieth layer holds something unusual would make the
// format's complexity somebody else's problem to work around.
func collectShapes(layers []psdLayer) []Shape {
	var shapes []Shape

	for _, layer := range layers {
		// A hidden group hides what is inside it, which the layer's own flag
		// does not say: Photoshop leaves a child's flag alone when its folder
		// is switched off.
		if !layer.visible() {
			continue
		}

		if path, ok := outlineOf(layer); ok {
			if subpaths := parsePath(path); len(subpaths) > 0 {
				shapes = append(shapes, Shape{Label: layer.name, Subpaths: subpaths})
			}
		}

		shapes = append(shapes, collectShapes(layer.children)...)
	}

	return shapes
}

// outlineOf returns a layer's vector path, whichever key it was written under.
func outlineOf(layer psdLayer) ([]byte, bool) {
	for _, key := range []string{keyVectorMaskShape, keyVectorMask} {
		if path, ok := layer.info[key]; ok && len(path) > 0 {
			return path, true
		}
	}
	return nil, false
}

// parsePath reads the fixed-size records of a vector mask.
//
// The layout is a version and flags, then a run of 26-byte records. A length
// record opens a subpath and says how many knots follow; the knot records carry
// the geometry; fill rule and clipboard records are Photoshop's business and
// are stepped over.
func parsePath(body []byte) []Subpath {
	r := &reader{buf: body}
	r.skip(4) // version
	r.skip(4) // flags

	var (
		subpaths []Subpath
		current  *Subpath
	)

	for r.remaining() >= pathRecordLen {
		selector := r.uint16()
		record := r.bytes(24)
		if r.err != nil {
			break
		}

		switch selector {
		case selClosedLength, selOpenLength:
			// A trailing length record with no knots after it describes an
			// empty subpath, which is nothing to draw.
			if current != nil && len(current.Knots) > 0 {
				subpaths = append(subpaths, *current)
			}
			current = &Subpath{Closed: selector == selClosedLength}

		case selClosedLinked, selClosedUnlinked, selOpenLinked, selOpenUnlinked:
			// A knot before any length record is malformed. Dropping it rather
			// than inventing a subpath keeps a partly-written file from drawing
			// a shape its author never made.
			if current == nil {
				continue
			}
			current.Knots = append(current.Knots, Knot{
				In:     point(record[0:8]),
				Anchor: point(record[8:16]),
				Out:    point(record[16:24]),
			})
		}
	}

	if current != nil && len(current.Knots) > 0 {
		subpaths = append(subpaths, *current)
	}

	return subpaths
}

// point reads one path coordinate pair.
//
// Vertical before horizontal, which is the opposite of every other coordinate
// in the format and the easiest thing here to get quietly wrong: swapping them
// still parses, and still draws a shape, just the wrong one.
func point(b []byte) Point {
	return Point{
		Y: fixedPoint(b[0:4]),
		X: fixedPoint(b[4:8]),
	}
}

// fixedPoint reads a signed 8.24 fixed-point number.
//
// Already a fraction of the canvas, which is why these are the only lengths in
// the file that need no division. Values outside 0..1 are legitimate: a shape
// may hang over the edge, and a template's crop box is often drawn a hair
// outside the canvas so its stroke does not eat into the picture.
func fixedPoint(b []byte) float64 {
	return float64(int32(uint32(b[0])<<24|uint32(b[1])<<16|uint32(b[2])<<8|uint32(b[3]))) / fixedPointOne
}

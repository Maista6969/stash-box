package croptemplate

import (
	"fmt"
	"unicode/utf16"
)

// This file walks the PSD container: the sections, lengths and signatures that
// stand between the start of the file and the three payloads this package
// actually wants - the guides resource, the XMP resource, and each layer's
// vector mask. Section names and offsets are from the Adobe Photoshop File
// Formats Specification; see the reference at the top of psd.go's constants.
//
// Only what a template can contain is read. PSB (version 2, 64-bit section
// lengths) is refused rather than handled: a crop template is a small RGB
// canvas, and accepting the large-document format would double every length
// field below for files nobody can ship

// psdFile is the part of a parsed container the rest of the package reads.
type psdFile struct {
	width  int
	height int
	// res maps an image resource ID to its raw payload
	res map[int][]byte
	// layers is the root of the layer tree, in file order - bottom layer
	// first, children of a group nested under it in the same order
	layers []psdLayer
}

type psdLayer struct {
	name  string
	flags uint8
	// info maps a four-character additional-info key to its raw payload
	info     map[string][]byte
	children []psdLayer
}

// visible reads the layer's own flag. Photoshop leaves a child's flag alone
// when its folder is switched off, so a caller walking the tree has to stop at
// a hidden group rather than trust each child
func (l psdLayer) visible() bool {
	return l.flags&2 == 0
}

// "File header section": signature, then a version that is 1 for PSD and 2
// for PSB
const (
	psdSignature = "8BPS"
	psdVersion   = 1
)

// "Layer records", flags byte: bit 1 is "visible", set means hidden

// decode walks a whole container. Nothing pixel-shaped is ever read: the
// section lengths let every raster be stepped over, and parsing stops after
// the layer records, before the channel image data they describe
func decode(data []byte) (psdFile, error) {
	r := &reader{buf: data}

	if sig := string(r.bytes(4)); r.err != nil || sig != psdSignature {
		return psdFile{}, fmt.Errorf("not a PSD file: signature %q", sig)
	}
	if version := r.uint16(); r.err != nil || version != psdVersion {
		return psdFile{}, fmt.Errorf("unsupported PSD version %d", version)
	}

	r.skip(6) // reserved
	r.skip(2) // channel count
	height := int(r.uint32())
	width := int(r.uint32())
	r.skip(2) // bit depth
	r.skip(2) // colour mode

	// "Color Mode Data Section": a length and a payload only indexed-colour
	// and duotone files fill in
	r.skip(int(r.uint32()))

	resources, err := parseResources(r.bytes(int(r.uint32())))
	if err == nil {
		err = r.err
	}
	if err != nil {
		return psdFile{}, err
	}

	// "Layer and Mask Information Section". Absent entirely in a flattened
	// file, which still makes a usable template if it carries guides
	var layers []psdLayer
	if r.remaining() >= 4 {
		if layers, err = parseLayerSection(r.bytes(int(r.uint32()))); err == nil {
			err = r.err
		}
		if err != nil {
			return psdFile{}, err
		}
	}

	return psdFile{width: width, height: height, res: resources, layers: layers}, nil
}

// parseResources walks the "Image Resources Section": a run of blocks, each a
// signature, an ID, a PascalCase name and a length-prefixed payload, name and
// payload each padded to an even length
func parseResources(block []byte) (map[int][]byte, error) {
	r := &reader{buf: block}
	resources := map[int][]byte{}

	for r.remaining() > 0 {
		if sig := string(r.bytes(4)); r.err != nil || sig != "8BIM" {
			return nil, fmt.Errorf("image resource block has signature %q, want 8BIM", sig)
		}
		id := int(r.uint16())

		nameLen := int(r.uint8())
		r.skip(nameLen)
		if (1+nameLen)%2 != 0 {
			r.skip(1)
		}

		size := int(r.uint32())
		data := r.bytes(size)
		if size%2 != 0 {
			r.skip(1)
		}
		if r.err != nil {
			return nil, r.err
		}

		resources[id] = data
	}

	return resources, nil
}

// parseLayerSection reads the "Layer Info" sub-section far enough to have
// every layer record, then assembles the tree. The channel image data that
// follows the records is never touched
func parseLayerSection(section []byte) ([]psdLayer, error) {
	r := &reader{buf: section}
	if r.remaining() < 4 {
		return nil, nil
	}

	info := &reader{buf: r.bytes(int(r.uint32()))}
	if r.err != nil {
		return nil, r.err
	}
	if info.remaining() < 2 {
		return nil, nil
	}

	// "Layer count. If it is a negative number, its absolute value is the
	// number of layers and the first alpha channel contains the transparency
	// data for the merged result."
	count := int(int16(info.uint16()))
	if count < 0 {
		count = -count
	}

	flat := make([]psdLayer, 0, count)
	for range count {
		layer, err := parseLayerRecord(info)
		if err != nil {
			return nil, err
		}
		flat = append(flat, layer)
	}

	return layerTree(flat)
}

// parseLayerRecord reads one entry of the layer records array: bounds and
// channels to step over, the flags, and the extra data holding the name and
// the additional-info blocks
func parseLayerRecord(r *reader) (psdLayer, error) {
	r.skip(16) // bounds

	// Channel info: 2 bytes of ID and 4 of data length per channel. The
	// lengths describe the image data after the records, which is never read
	channels := int(r.uint16())
	r.skip(channels * 6)

	if sig := string(r.bytes(4)); r.err == nil && sig != "8BIM" {
		return psdLayer{}, fmt.Errorf("layer record has blend signature %q, want 8BIM", sig)
	}
	r.skip(4) // blend mode key
	r.skip(2) // opacity, clipping
	flags := r.uint8()
	r.skip(1) // filler

	extra := &reader{buf: r.bytes(int(r.uint32()))}
	if r.err != nil {
		return psdLayer{}, r.err
	}

	extra.skip(int(extra.uint32())) // layer mask data
	extra.skip(int(extra.uint32())) // blending ranges

	// The legacy name is a PascalCase string padded so it and its length byte
	// occupy a multiple of four here, not two as elsewhere
	nameLen := int(extra.uint8())
	name := string(extra.bytes(nameLen))
	if pad := (1 + nameLen) % 4; pad != 0 {
		extra.skip(4 - pad)
	}

	info, err := parseAdditionalInfo(extra)
	if err != nil {
		return psdLayer{}, err
	}
	if extra.err != nil {
		return psdLayer{}, extra.err
	}

	// The Unicode name wins over the legacy one, which Photoshop truncates
	// and transliterates
	if data, ok := info["luni"]; ok {
		if unicode, ok := unicodeString(data); ok {
			name = unicode
		}
		delete(info, "luni")
	}

	return psdLayer{name: name, flags: flags, info: info}, nil
}

// parseAdditionalInfo walks the additional-info blocks at the end of a layer
// record: a signature, a four-character key, and a length-prefixed payload
//
// The spec pads these blocks inconsistently - to two bytes in some producers,
// four in others, not at all in more - so, like every other reader of this
// format, this scans forward to the next signature byte rather than trusting
// any one padding rule
func parseAdditionalInfo(r *reader) (map[string][]byte, error) {
	info := map[string][]byte{}

	for r.remaining() > 0 {
		for r.remaining() > 0 && r.buf[r.pos] != '8' {
			r.skip(1)
		}
		if r.remaining() < 12 {
			break
		}

		if sig := string(r.bytes(4)); sig != "8BIM" && sig != "8B64" {
			return nil, fmt.Errorf("additional info block has signature %q", sig)
		}
		key := string(r.bytes(4))
		data := r.bytes(int(r.uint32()))
		if r.err != nil {
			return nil, r.err
		}

		info[key] = data
	}

	return info, nil
}

// layerTree folds the flat record list into a tree using the section divider
// key: a type-3 divider closes off the run of layers that will become a
// group's children, and the group layer itself (type 1 or 2, open or closed
// folder) follows them and claims the run. File order is preserved throughout,
// because shape order is presentation order
func layerTree(flat []psdLayer) ([]psdLayer, error) {
	var stack [][]psdLayer
	current := []psdLayer{}

	for i, layer := range flat {
		switch dividerType(layer) {
		case 1, 2:
			layer.children = current
			if len(stack) == 0 {
				return nil, fmt.Errorf("layer %d closes a group nothing opened", i)
			}
			current = stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			current = append(current, layer)
		case 3:
			stack = append(stack, current)
			current = []psdLayer{}
		default:
			current = append(current, layer)
		}
	}

	if len(stack) != 0 {
		return nil, fmt.Errorf("%d group(s) opened and never closed", len(stack))
	}
	return current, nil
}

// dividerType reads the "Section divider setting" of a layer: 0 for an
// ordinary layer, 1 or 2 for a group, 3 for the hidden marker that bounds one
func dividerType(layer psdLayer) uint32 {
	for _, key := range []string{"lsct", "lsdk"} {
		if data, ok := layer.info[key]; ok && len(data) >= 4 {
			return uint32(data[0])<<24 | uint32(data[1])<<16 | uint32(data[2])<<8 | uint32(data[3])
		}
	}
	return 0
}

// unicodeString reads a luni payload: a character count, then UTF-16
func unicodeString(data []byte) (string, bool) {
	if len(data) < 4 {
		return "", false
	}
	count := int(uint32(data[0])<<24 | uint32(data[1])<<16 | uint32(data[2])<<8 | uint32(data[3]))
	if count < 0 || len(data)-4 < count*2 {
		return "", false
	}

	units := make([]uint16, count)
	for i := range units {
		units[i] = uint16(data[4+i*2])<<8 | uint16(data[5+i*2])
	}
	return string(utf16.Decode(units)), true
}

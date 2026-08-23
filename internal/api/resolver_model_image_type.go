package api

import (
	"context"

	"github.com/stashapp/stash-box/internal/image/croptemplate"
	"github.com/stashapp/stash-box/internal/models"
)

type imageTypeResolver struct{ *Resolver }

// CropTemplate is the frame to crop to for a type, read from the Photoshop
// template it ships with
//
// A field resolver rather than something carried on the model, so the template
// is parsed only when a client asks for the frame. Most types have no template
// at all - nothing about a pose or a state of dress says anything about the
// shape of the picture
func (r *imageTypeResolver) CropTemplate(ctx context.Context, obj *models.ImageType) (*models.CropTemplate, error) {
	template, ok := r.services.CropTemplates().Template(string(obj.Key))
	if !ok {
		return nil, nil
	}

	guides := make([]models.CropGuide, 0, len(template.Guides))
	for _, guide := range template.Guides {
		guides = append(guides, models.CropGuide{
			Axis:     models.CropGuideAxisEnum(guide.Axis),
			Position: guide.Position,
			Role:     cropGuideRole(guide.Role),
			Label:    cropGuideLabel(guide.Label),
			Pivot:    guide.Pivot,
		})
	}

	return &models.CropTemplate{
		AspectRatio: template.AspectRatio(),
		Guides:      guides,
		Shapes:      cropShapes(template.Shapes),
	}, nil
}

// cropShapes converts the outlines a template draws on its own layers
//
// A straight copy of the geometry rather than an SVG path built here: the
// client draws one, but a bounding box or a centre is the kind of thing the
// frame will want next, and a string it would have to parse back is a poor way
// to hand it over
func cropShapes(shapes []croptemplate.Shape) []models.CropShape {
	out := make([]models.CropShape, 0, len(shapes))

	for _, shape := range shapes {
		subpaths := make([]models.CropSubpath, 0, len(shape.Subpaths))
		for _, subpath := range shape.Subpaths {
			knots := make([]models.CropKnot, 0, len(subpath.Knots))
			for _, knot := range subpath.Knots {
				knots = append(knots, models.CropKnot{
					ControlIn:  cropPoint(knot.In),
					Anchor:     cropPoint(knot.Anchor),
					ControlOut: cropPoint(knot.Out),
				})
			}
			subpaths = append(subpaths, models.CropSubpath{
				Closed: subpath.Closed,
				Knots:  knots,
			})
		}

		out = append(out, models.CropShape{
			Label:    cropGuideLabel(shape.Label),
			Subpaths: subpaths,
		})
	}

	return out
}

func cropPoint(p croptemplate.Point) *models.CropPoint {
	return &models.CropPoint{X: p.X, Y: p.Y}
}

// cropGuideRole maps an unroled guide to null rather than to an empty string a
// client would have to know to ignore. A template need not say how closely each
// of its lines is meant to be followed
//
// Empty is the only value needing translation: croptemplate normalises a role
// it does not recognise to empty when it reads the template, so anything else
// arriving here is already one of the known ones
func cropGuideRole(role croptemplate.Role) *models.CropGuideRoleEnum {
	if role == "" {
		return nil
	}
	out := models.CropGuideRoleEnum(role)
	return &out
}

func cropGuideLabel(label string) *string {
	if label == "" {
		return nil
	}
	return &label
}

import type { CropShape, CropSubpath } from "src/graphql";

/**
 * Turning a template's outlines into SVG path data.
 *
 * Photoshop and SVG describe a curve the same way -- anchors with a control
 * point either side -- so this is a transcription rather than a conversion, and
 * every segment is a cubic even when it is visibly straight. A rectangle drawn
 * with the shape tool arrives as four cubics whose controls sit on their
 * anchors, and writing it out as one keeps rectangles and ellipses on the same
 * path through here
 */

/**
 * Enough places for a canvas far larger than anything a template is drawn at,
 * and few enough that the string stays readable. At five decimals a fraction
 * resolves to a tenth of a pixel on a 10,000px image.
 */
const PLACES = 5;

const round = (value: number) => Number(value.toFixed(PLACES));

const at = (point: { x: number; y: number }) =>
  `${round(point.x)},${round(point.y)}`;

const subpathData = (subpath: CropSubpath) => {
  const { knots } = subpath;
  if (knots.length === 0) return "";

  // A single knot is a point: it has no segment to draw, and emitting a
  // zero-length curve leaves a stroke cap sitting on the image like a speck of
  // dust on the lens
  if (knots.length === 1) return "";

  const parts = [`M${at(knots[0].anchor)}`];

  for (let i = 1; i < knots.length; i++) {
    parts.push(
      `C${at(knots[i - 1].control_out)} ${at(knots[i].control_in)} ${at(knots[i].anchor)}`,
    );
  }

  if (subpath.closed) {
    // The closing segment is a curve like any other, so it has to be written
    // out: a bare Z draws a straight line home and would flatten one quarter of
    // every ellipse
    const last = knots[knots.length - 1];
    const first = knots[0];
    parts.push(
      `C${at(last.control_out)} ${at(first.control_in)} ${at(first.anchor)}`,
      "Z",
    );
  }

  return parts.join("");
};

/** One shape's outlines as a single `d` attribute */
export const shapePath = (shape: CropShape) =>
  shape.subpaths.map(subpathData).filter(Boolean).join(" ");

/**
 * The extent of a shape, for hanging a label on
 *
 * Anchors only. A control point can sit well outside the outline it governs --
 * on an ellipse they reach past every side - so including them would put the
 * label somewhere the shape never goes
 *
 * Undefined for a shape with no knots, which has no position to speak of
 */
export const shapeBounds = (shape: CropShape) => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const subpath of shape.subpaths) {
    for (const { anchor } of subpath.knots) {
      minX = Math.min(minX, anchor.x);
      maxX = Math.max(maxX, anchor.x);
      minY = Math.min(minY, anchor.y);
      maxY = Math.max(maxY, anchor.y);
    }
  }

  if (!Number.isFinite(minX)) return undefined;
  return { minX, minY, maxX, maxY };
};

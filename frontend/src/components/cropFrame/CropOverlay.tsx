import cx from "classnames";
import type { FC } from "react";
import {
  type CropGuide,
  CropGuideAxisEnum,
  CropGuideRoleEnum,
  type CropShape,
} from "src/graphql";

import { largestCenteredRect } from "./geometry";
import { shapeBounds, shapePath } from "./shapePath";

const CLASSNAME = "CropOverlay";

export interface CropTemplateInfo {
  aspectRatio: number;
  guides: CropGuide[];
  shapes: CropShape[];
}

interface CropOverlayProps {
  guides: CropGuide[];
  /** Outlines drawn on the template's own layers, if it has any */
  shapes?: CropShape[];
  /**
   * Lines the current drag is holding still, as fractions of the frame. Marked
   * so a resize that behaves differently also looks different
   */
  held?: { x?: number; y?: number };
  /**
   * Shrink the overlay to a box of the template's shape, centred, instead of
   * filling whatever it is placed in
   *
   * For drawing over a finished image, whose proportions are its own and need
   * not be the template's. Without this the geometry is stretched onto the
   * picture and an image that does not fit the frame is drawn as though it
   * does which is the one thing the overlay is there to disprove.
   *
   * Not wanted inside the cropping tool, where the box the overlay sits in is
   * already the frame and already the right shape
   */
  fit?: { templateAspect: number; imageAspect: number };
}

/** How far from filling its box before the frame edge is worth drawing */
const INSET_EPSILON = 0.005;

/**
 * A template's guide lines, drawn over whatever box this is placed in
 *
 * Positioned with percentages rather than drawn into an SVG viewBox, so the
 * lines stay one pixel wide whatever shape the box is. A stretched viewBox
 * gives horizontal and vertical strokes different weights, which reads as a
 * rendering fault
 *
 * Named lines are the ones meant to be lined up on (the eye line, where the
 * thighs meet) and labelling the thirds and margins as well turns a frame into
 * a wall of text. The rest still carry their name as a tooltip
 *
 * That is anchors and the pivot, not anchors alone. The eye line is the example
 * this rule was written for and it is a reference, because the head and the
 * chin are the hard limits in a headshot; keying the name off the role alone
 * left the one line the template resizes about as the only unnamed thing in it
 */
const CropOverlay: FC<CropOverlayProps> = ({
  guides,
  shapes = [],
  held,
  fit,
}) => {
  // The largest box of the template's shape that fits the picture, centred:
  // the same rectangle the cropping tool starts a frame at, and for the same
  // reason. It is where the crop would be if it were being made now
  const frame = fit
    ? largestCenteredRect(fit.templateAspect, fit.imageAspect)
    : undefined;

  // Only worth drawing an edge when there is something outside it. On an image
  // that already fits, the border would land exactly on the picture's own edge
  // and read as a stray line
  const inset =
    frame !== undefined &&
    (frame.width < 1 - INSET_EPSILON || frame.height < 1 - INSET_EPSILON);

  return (
    <div
      className={cx(CLASSNAME, { [`${CLASSNAME}-inset`]: inset })}
      style={
        frame && {
          left: `${frame.x * 100}%`,
          top: `${frame.y * 100}%`,
          width: `${frame.width * 100}%`,
          height: `${frame.height * 100}%`,
        }
      }
    >
      {/*
      One SVG for every outline, stretched over the box by a unit viewBox so
      the fractions the template stores need no conversion.

      preserveAspectRatio="none" is deliberate: the template's canvas and the
      frame drawn over the photograph are the same shape, so stretching to fill
      is what puts the oval where the designer drew it. non-scaling-stroke then
      undoes that stretch for the stroke alone, which is what keeps a line one
      pixel wide in both directions - the same problem the guides avoid by
      being positioned in percentages rather than drawn in here.
    */}
      {shapes.length > 0 && (
        <svg
          className={`${CLASSNAME}-shapes`}
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {shapes.map((shape) => {
            // Nothing in a template identifies a shape and two layers may share a
            // name, so the outline itself is the key. Two shapes alike enough to
            // collide are drawing the same line in the same place
            const d = shapePath(shape);

            return (
              <path
                key={`${shape.label ?? ""}${d}`}
                className={`${CLASSNAME}-shape`}
                d={d}
                vectorEffect="non-scaling-stroke"
              >
                {shape.label && <title>{shape.label}</title>}
              </path>
            );
          })}
        </svg>
      )}

      {shapes.map((shape) => {
        const bounds = shape.label ? shapeBounds(shape) : undefined;
        if (!bounds) return null;

        return (
          <span
            key={`label-${shape.label}-${bounds.minY}`}
            className={cx(`${CLASSNAME}-label`, `${CLASSNAME}-shape-label`)}
            style={{
              left: `${((bounds.minX + bounds.maxX) / 2) * 100}%`,
              top: `${bounds.minY * 100}%`,
            }}
          >
            {shape.label}
          </span>
        );
      })}

      {guides.map((guide) => {
        const vertical = guide.axis === CropGuideAxisEnum.X;
        const percent = `${guide.position * 100}%`;
        const anchor = guide.role === CropGuideRoleEnum.ANCHOR;
        const holdAt = vertical ? held?.x : held?.y;
        const isHeld =
          holdAt !== undefined && Math.abs(holdAt - guide.position) < 1e-6;

        return (
          <div
            key={`${guide.axis}-${guide.position}`}
            className={cx(`${CLASSNAME}-guide`, {
              [`${CLASSNAME}-guide-vertical`]: vertical,
              [`${CLASSNAME}-guide-horizontal`]: !vertical,
              [`${CLASSNAME}-guide-anchor`]: anchor,
              [`${CLASSNAME}-guide-margin`]:
                guide.role === CropGuideRoleEnum.MARGIN,
              [`${CLASSNAME}-guide-held`]: isHeld,
            })}
            style={vertical ? { left: percent } : { top: percent }}
            title={guide.label ?? undefined}
          >
            {(anchor || guide.pivot) && guide.label && (
              <span className={`${CLASSNAME}-label`}>{guide.label}</span>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CropOverlay;

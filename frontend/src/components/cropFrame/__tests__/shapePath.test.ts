import type { CropShape, CropSubpath } from "src/graphql";
import { describe, expect, it } from "vitest";

import { shapePath } from "../shapePath";

const point = (x: number, y: number) => ({
  __typename: "CropPoint" as const,
  x,
  y,
});

/** A knot whose controls sit on its anchor, which is a straight corner. */
const corner = (x: number, y: number) => ({
  __typename: "CropKnot" as const,
  control_in: point(x, y),
  anchor: point(x, y),
  control_out: point(x, y),
});

const knot = (
  anchor: [number, number],
  cin: [number, number],
  cout: [number, number],
) => ({
  __typename: "CropKnot" as const,
  control_in: point(...cin),
  anchor: point(...anchor),
  control_out: point(...cout),
});

const subpath = (knots: CropSubpath["knots"], closed = true): CropSubpath => ({
  __typename: "CropSubpath" as const,
  closed,
  knots,
});

const shape = (subpaths: CropSubpath[]): CropShape => ({
  __typename: "CropShape" as const,
  label: null,
  subpaths,
});

describe("shapePath", () => {
  it("starts at the first anchor", () => {
    const d = shapePath(
      shape([subpath([corner(0.1, 0.2), corner(0.9, 0.2), corner(0.9, 0.8)])]),
    );
    expect(d.startsWith("M0.1,0.2")).toBe(true);
  });

  // Photoshop has no straight segment: it draws one as a curve whose controls
  // sit on its anchors. Writing every segment as a cubic is what lets a
  // rectangle and an ellipse come through the same code.
  it("writes every segment as a cubic", () => {
    const d = shapePath(
      shape([subpath([corner(0, 0), corner(1, 0), corner(1, 1)], false)]),
    );
    expect(d.match(/C/g)).toHaveLength(2);
    expect(d).not.toContain("L");
  });

  // The segment back to the start is a curve like any other. A bare Z draws a
  // straight line home, which would flatten one quarter of every ellipse
  it("closes with a curve, not a straight line", () => {
    const top = knot([0.5, 0.02], [0.28, 0.02], [0.72, 0.02]);
    const right = knot([0.9, 0.4], [0.9, 0.19], [0.9, 0.6]);
    const bottom = knot([0.5, 0.77], [0.72, 0.77], [0.28, 0.77]);
    const left = knot([0.09, 0.4], [0.09, 0.6], [0.09, 0.19]);

    const d = shapePath(shape([subpath([top, right, bottom, left])]));

    // Four knots, four segments: three between them and one home again
    expect(d.match(/C/g)).toHaveLength(4);
    expect(d.endsWith("Z")).toBe(true);
    // The closing curve carries the last knot's outgoing control and the
    // first's incoming one, which is exactly what a bare Z would discard
    expect(d).toContain("C0.09,0.19 0.28,0.02 0.5,0.02Z");
  });

  it("leaves an open subpath open", () => {
    const d = shapePath(shape([subpath([corner(0, 0), corner(1, 1)], false)]));
    expect(d).not.toContain("Z");
    expect(d.match(/C/g)).toHaveLength(1);
  });

  it("joins a shape's subpaths into one path", () => {
    const d = shapePath(
      shape([
        subpath([corner(0, 0), corner(1, 0), corner(1, 1)]),
        subpath([corner(0.2, 0.2), corner(0.8, 0.2), corner(0.8, 0.8)]),
      ]),
    );
    expect(d.match(/M/g)).toHaveLength(2);
  });

  // A stroke cap on a zero-length curve sits on the picture like a speck of
  // dust on the lens
  it("draws nothing for a subpath with no segment", () => {
    expect(shapePath(shape([subpath([corner(0.5, 0.5)])]))).toBe("");
    expect(shapePath(shape([subpath([])]))).toBe("");
  });
});

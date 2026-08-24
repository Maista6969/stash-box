import { render } from "@testing-library/react";
import {
  type CropGuide,
  CropGuideAxisEnum,
  CropGuideRoleEnum,
  type CropShape,
} from "src/graphql";
import { describe, expect, it } from "vitest";
import CropOverlay from "../CropOverlay";

const guide = (
  axis: CropGuideAxisEnum,
  position: number,
  role: CropGuideRoleEnum | null,
  label: string | null,
  pivot = false,
): CropGuide => ({
  __typename: "CropGuide" as const,
  axis,
  position,
  role,
  label,
  pivot,
});

const GUIDES: CropGuide[] = [
  guide(CropGuideAxisEnum.X, 0.015, CropGuideRoleEnum.MARGIN, "Left margin"),
  guide(CropGuideAxisEnum.X, 0.5, CropGuideRoleEnum.REFERENCE, "Centre"),
  guide(
    CropGuideAxisEnum.Y,
    0.425,
    CropGuideRoleEnum.ANCHOR,
    "Bisects the eyes",
  ),
  guide(CropGuideAxisEnum.Y, 0.77, CropGuideRoleEnum.REFERENCE, "Chin"),
  guide(CropGuideAxisEnum.Y, 0.9, null, null),
];

const lines = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".CropOverlay-guide"));

describe("CropOverlay", () => {
  it("draws every guide the template carries", () => {
    const { container } = render(<CropOverlay guides={GUIDES} />);
    expect(lines(container)).toHaveLength(GUIDES.length);
  });

  it("draws nothing for a template with no guides", () => {
    const { container } = render(<CropOverlay guides={[]} />);
    expect(lines(container)).toHaveLength(0);
  });

  // A vertical guide is placed across the width and a horizontal one down the
  // height. Putting a position on the wrong axis is the mistake that makes an
  // overlay look plausible and be wrong.
  it("places each guide along its own axis", () => {
    const { container } = render(<CropOverlay guides={GUIDES} />);
    const drawn = lines(container) as HTMLElement[];

    const vertical = drawn.filter((line) =>
      line.classList.contains("CropOverlay-guide-vertical"),
    );
    const horizontal = drawn.filter((line) =>
      line.classList.contains("CropOverlay-guide-horizontal"),
    );

    expect(vertical).toHaveLength(2);
    expect(horizontal).toHaveLength(3);

    expect(vertical[0].style.left).toBe("1.5%");
    expect(vertical[0].style.top).toBe("");
    expect(horizontal[0].style.top).toBe("42.5%");
    expect(horizontal[0].style.left).toBe("");
  });

  // Anchors are the lines meant to be hit, so they are the ones worth reading
  // on the image. Naming the thirds and margins as well turns a frame into a
  // wall of text.
  it("names anchors on the image and leaves the rest to a tooltip", () => {
    const { container, queryByText } = render(<CropOverlay guides={GUIDES} />);

    expect(queryByText("Bisects the eyes")).not.toBeNull();
    expect(queryByText("Chin")).toBeNull();
    expect(queryByText("Left margin")).toBeNull();

    const titles = lines(container).map((line) => line.getAttribute("title"));
    expect(titles).toContain("Chin");
    expect(titles).toContain("Left margin");
  });

  // The pivot is named whatever its role. It is the line the frame resizes
  // about, so it is by definition one to line up on -- and in the face
  // template it is a reference, because the head and the chin are the hard
  // limits there. Keying the name off the role alone left the one line the
  // template turns about as the only unnamed thing on it.
  it("names the pivot even when it is only a reference", () => {
    const { queryByText } = render(
      <CropOverlay
        guides={[
          guide(
            CropGuideAxisEnum.Y,
            0.397,
            CropGuideRoleEnum.REFERENCE,
            "Bisects the eyes",
            true,
          ),
          guide(CropGuideAxisEnum.Y, 0.77, CropGuideRoleEnum.REFERENCE, "Chin"),
        ]}
      />,
    );

    expect(queryByText("Bisects the eyes")).not.toBeNull();
    // And still nothing for the reference that is not the pivot.
    expect(queryByText("Chin")).toBeNull();
  });

  // A template need not say how closely each line should be followed, and an
  // unnamed guide is still a usable one.
  it("draws a guide with no role or label", () => {
    const { container } = render(
      <CropOverlay guides={[guide(CropGuideAxisEnum.Y, 0.5, null, null)]} />,
    );

    const drawn = lines(container) as HTMLElement[];
    expect(drawn).toHaveLength(1);
    expect(drawn[0].style.top).toBe("50%");
    expect(drawn[0].getAttribute("title")).toBeNull();
  });
});

/**
 * Outlines drawn on a template's own layers, rather than dragged off a ruler.
 * A template whose whole content is an oval for a face has no guides at all,
 * so this is the only thing it draws.
 */
describe("CropOverlay shapes", () => {
  const point = (x: number, y: number) => ({
    __typename: "CropPoint" as const,
    x,
    y,
  });
  const corner = (x: number, y: number) => ({
    __typename: "CropKnot" as const,
    control_in: point(x, y),
    anchor: point(x, y),
    control_out: point(x, y),
  });
  const shape = (label: string | null): CropShape => ({
    __typename: "CropShape" as const,
    label,
    subpaths: [
      {
        __typename: "CropSubpath" as const,
        closed: true,
        knots: [corner(0.1, 0.1), corner(0.9, 0.1), corner(0.9, 0.9)],
      },
    ],
  });

  const paths = () => document.querySelectorAll(".CropOverlay-shape");

  it("draws one path per shape", () => {
    render(<CropOverlay guides={[]} shapes={[shape("head"), shape(null)]} />);
    expect(paths()).toHaveLength(2);
  });

  it("gives each path its outline", () => {
    render(<CropOverlay guides={[]} shapes={[shape("head")]} />);
    expect(paths()[0].getAttribute("d")).toContain("M0.1,0.1");
  });

  it("names a shape that has a name", () => {
    render(<CropOverlay guides={[]} shapes={[shape("head guide")]} />);
    expect(paths()[0].querySelector("title")?.textContent).toBe("head guide");
  });

  it("draws nothing at all without shapes", () => {
    render(<CropOverlay guides={[]} />);
    expect(document.querySelector(".CropOverlay-shapes")).toBeNull();
  });
});

describe("CropOverlay shape labels", () => {
  const point = (x: number, y: number) => ({
    __typename: "CropPoint" as const,
    x,
    y,
  });
  const corner = (x: number, y: number) => ({
    __typename: "CropKnot" as const,
    // Controls well outside the outline, as an ellipse's are. Including them
    // in the extent would put the label where the shape never goes.
    control_in: point(x - 0.3, y - 0.3),
    anchor: point(x, y),
    control_out: point(x + 0.3, y + 0.3),
  });
  const oval = (label: string | null): CropShape => ({
    __typename: "CropShape" as const,
    label,
    subpaths: [
      {
        __typename: "CropSubpath" as const,
        closed: true,
        knots: [corner(0.2, 0.1), corner(0.8, 0.1), corner(0.8, 0.7)],
      },
    ],
  });

  const label = () =>
    document.querySelector(".CropOverlay-shape-label") as HTMLElement;

  it("names a shape on the overlay, not only in a tooltip", () => {
    render(<CropOverlay guides={[]} shapes={[oval("head guide")]} />);
    expect(label().textContent).toBe("head guide");
  });

  // Centred across the outline and on its top edge, from the anchors alone.
  it("hangs the name on the crown of the outline", () => {
    render(<CropOverlay guides={[]} shapes={[oval("head guide")]} />);
    expect(label().style.left).toBe("50%");
    expect(Number.parseFloat(label().style.top)).toBeCloseTo(10, 4);
  });

  it("says nothing about an unnamed shape", () => {
    render(<CropOverlay guides={[]} shapes={[oval(null)]} />);
    expect(document.querySelector(".CropOverlay-shape-label")).toBeNull();
  });
});

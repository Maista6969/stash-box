import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import {
  CropGuideAxisEnum,
  CropGuideRoleEnum,
  ImageTypeEnum,
  ImageTypeGroupEnum,
  type ImageTypeGroupsQuery,
} from "src/graphql";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CropStep, { type CropStepHandle } from "../CropStep";

type Groups = ImageTypeGroupsQuery["imageTypeGroups"];

const template = (aspectRatio: number) => ({
  __typename: "CropTemplate" as const,
  aspect_ratio: aspectRatio,
  shapes: [],
  guides: [
    {
      __typename: "CropGuide" as const,
      axis: CropGuideAxisEnum.Y,
      position: 0.425,
      role: CropGuideRoleEnum.ANCHOR,
      label: "Bisects the eyes",
      pivot: false,
    },
  ],
});

// A crop group where two types have templates and one does not, plus a group
// describing the subject rather than the frame.
const GROUPS: Groups = [
  {
    __typename: "ImageTypeGroup" as const,
    enabled: true,
    key: ImageTypeGroupEnum.CROP,
    name: "Crop",
    description: "How much of the subject is in frame?",
    types: [
      {
        __typename: "ImageType" as const,
        enabled: true,
        key: ImageTypeEnum.CROP_FACE,
        name: "Face",
        description: "Collarbone up.",
        conflicts_with: [],
        crop_template: template(2 / 3),
      },
      {
        __typename: "ImageType" as const,
        enabled: true,
        key: ImageTypeEnum.CROP_WIDE,
        name: "Wide",
        description: "Subject horizontal.",
        conflicts_with: [],
        crop_template: template(16 / 9),
      },
      {
        __typename: "ImageType" as const,
        enabled: true,
        key: ImageTypeEnum.CROP_TORSO,
        name: "Torso",
        description: "Hips to shoulders.",
        conflicts_with: [],
        crop_template: null,
      },
    ],
  },
  {
    __typename: "ImageTypeGroup" as const,
    enabled: true,
    key: ImageTypeGroupEnum.VIEW,
    name: "Pose",
    description: "Which way is the subject facing?",
    types: [
      {
        __typename: "ImageType" as const,
        enabled: true,
        key: ImageTypeEnum.VIEW_FRONT,
        name: "Front",
        description: null,
        conflicts_with: [],
        crop_template: null,
      },
    ],
  },
];

const file = () => new File(["pixels"], "photo.jpg", { type: "image/jpeg" });

// Whether choosing a frame crops anything depends entirely on the picture's
// shape: a 2:3 template on a 2:3 photograph selects the whole thing, which is
// not a crop.
let bitmap = { width: 300, height: 300 };
vi.stubGlobal("createImageBitmap", () =>
  Promise.resolve({ ...bitmap, close: () => {} }),
);
beforeEach(() => {
  bitmap = { width: 300, height: 300 };
});

// Remove, the crop-specific Reset and Upload are driven by a parent through
// this handle now -- see editImages.tsx for why -- so tests call it directly
// rather than clicking buttons CropStep no longer renders.
const setup = (onUpload = vi.fn()) => {
  const ref = createRef<CropStepHandle>();
  const onCropsChange = vi.fn();
  const utils = render(
    <CropStep
      ref={ref}
      file={file()}
      groups={GROUPS}
      onCropsChange={onCropsChange}
      onUpload={onUpload}
    />,
  );
  const crops = () => onCropsChange.mock.calls.at(-1)?.[0] as boolean;
  return {
    ...utils,
    ref,
    onUpload,
    onCropsChange,
    crops,
    user: userEvent.setup(),
  };
};

/** The picture has finished decoding once the label control is on screen. */
const ready = () => screen.findByLabelText("Add label");

/** One control for every label, the crop among them. */
const chooseLabel = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(screen.getByLabelText("Add label"));
  await user.click(await screen.findByText(name));
};

const frame = () => document.querySelector(".CropFrame-frame");

describe("CropStep", () => {
  // The old flow, untouched: choose a file, upload as-is. Nothing about
  // cropping is reported until cropping is what is happening -- the parent
  // reads this to decide whether its Upload button says "Crop and upload"
  // and whether to offer Reset.
  it("reports no crop until something is cropped", async () => {
    const { crops } = setup();
    await ready();

    expect(crops()).toBe(false);
  });

  // Nothing to hold a shape against and no line to line anything up on, so a
  // border and four handles would only ever select the whole picture.
  it("draws no frame until a crop is chosen", async () => {
    const { user } = setup();
    await ready();

    expect(frame()).toBeNull();
    expect(screen.queryByRole("button", { name: "Resize se" })).toBeNull();

    await chooseLabel(user, "Face");

    await waitFor(() => expect(frame()).not.toBeNull());
    expect(
      screen.getByRole("button", { name: "Resize se" }),
    ).toBeInTheDocument();
  });

  // A crop the instance has no template for is a label and nothing more.
  it("draws no frame for a crop with no template", async () => {
    const { user } = setup();
    await ready();

    await chooseLabel(user, "Torso");

    expect(frame()).toBeNull();
  });

  // The whole point: the frame and the label are chosen in one action, so the
  // type describes what was done rather than being a judgement made later.
  it("sends the frame and the type together", async () => {
    const { ref, onUpload, crops, user } = setup();
    await ready();

    await chooseLabel(user, "Face");
    expect(crops()).toBe(true);
    ref.current?.upload();

    expect(onUpload).toHaveBeenCalledTimes(1);
    const [crop, types] = onUpload.mock.calls[0];
    expect(types).toContain(ImageTypeEnum.CROP_FACE);
    expect(crop).toMatchObject({ angle: 0 });
    expect(crop.width).toBeGreaterThan(0);
  });

  // The frame's fractions are of two different spans, so the image's own
  // proportions have to enter the calculation.
  it("shapes the frame to the chosen template", async () => {
    // A square picture, so both templates crop something. Rendered separately
    // rather than switched: the label control hides a group's other values
    // once one of them is chosen, since the groups are exclusive.
    const imageAspect = 1;

    const cropWith = async (name: string) => {
      const { ref, onUpload, user, unmount } = setup();
      await ready();
      await chooseLabel(user, name);
      ref.current?.upload();
      const crop = onUpload.mock.calls[0][0];
      unmount();
      return crop;
    };

    const portrait = await cropWith("Face");
    expect((portrait.width * imageAspect) / portrait.height).toBeCloseTo(2 / 3);

    const landscape = await cropWith("Wide");
    expect((landscape.width * imageAspect) / landscape.height).toBeCloseTo(
      16 / 9,
    );

    expect(portrait.height).toBeGreaterThan(landscape.height);
  });

  it("draws the template's guides over the frame", async () => {
    const { user } = setup();
    await ready();

    expect(document.querySelectorAll(".CropOverlay-guide")).toHaveLength(0);

    await chooseLabel(user, "Face");

    await waitFor(() =>
      expect(document.querySelectorAll(".CropOverlay-guide")).toHaveLength(1),
    );
    expect(screen.getByText("Bisects the eyes")).toBeInTheDocument();
  });

  // The same file the guides were read from, so someone cropping in their own
  // editor works to the identical frame.
  it("offers the chosen template for download", async () => {
    const { user } = setup();
    await ready();

    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();

    await chooseLabel(user, "Face");

    const link = screen.getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute("href", "/crop-templates/CROP_FACE");
    expect(link).toHaveAttribute("download");
  });

  // Changing your mind is Reset and then Upload -- the same two words, in the
  // same places, as before any of this existed.
  it("resets back to the untouched file", async () => {
    const { ref, onUpload, crops, user } = setup();
    await ready();

    await chooseLabel(user, "Face");
    expect(crops()).toBe(true);

    act(() => ref.current?.reset());

    expect(crops()).toBe(false);
    await waitFor(() => expect(frame()).toBeNull());

    ref.current?.upload();
    expect(onUpload).toHaveBeenCalledWith(undefined, [], null);
  });

  // Resetting is about the cropping, not about everything said of the picture.
  it("keeps the other labels through a reset", async () => {
    const { ref, onUpload, user } = setup();
    await ready();

    await chooseLabel(user, "Front");
    await chooseLabel(user, "Face");
    act(() => ref.current?.reset());
    ref.current?.upload();

    expect(onUpload).toHaveBeenCalledWith(
      undefined,
      [ImageTypeEnum.VIEW_FRONT],
      null,
    );
  });
});

describe("CropStep on a picture already the right shape", () => {
  beforeEach(() => {
    bitmap = { width: 200, height: 300 };
  });

  // A 2:3 template on a 2:3 photograph selects the whole thing. There is
  // nothing to cut, so nothing offers to cut it -- but the picture is still a
  // Face crop, and saying so is the whole point of choosing it.
  it("labels without cropping when the frame cuts nothing", async () => {
    const { ref, onUpload, crops, user } = setup();
    await ready();

    await chooseLabel(user, "Face");

    expect(crops()).toBe(false);
    ref.current?.upload();

    expect(onUpload).toHaveBeenCalledWith(
      undefined,
      [ImageTypeEnum.CROP_FACE],
      null,
    );
  });
});

describe("CropStep layout stability", () => {
  // Choosing a crop used to insert two lines of text - the template above the
  // picture and the Shift hint below it - which shoved the picture down at the
  // moment someone was looking at it. Both rows are now always there
  it("keeps the same rows before and after a crop is chosen", async () => {
    const { user } = setup();
    await ready();

    const rows = () => ({
      template: document.querySelectorAll(".CropStep-template").length,
      hint: document.querySelectorAll(".CropFrame-hint").length,
    });

    const before = rows();
    expect(before.template).toBe(1);
    expect(before.hint).toBe(1);

    await chooseLabel(user, "Face");
    await waitFor(() => expect(frame()).not.toBeNull());

    expect(rows()).toEqual(before);
  });

  // Reserved, not read out: there is nothing to say about a modifier for a
  // frame that does not exist
  it("hides the Shift hint rather than removing it", async () => {
    const { user } = setup();
    await ready();

    const hint = () => document.querySelector(".CropFrame-hint") as HTMLElement;
    expect(hint().style.visibility).toBe("hidden");

    await chooseLabel(user, "Face");

    await waitFor(() => expect(hint().style.visibility).toBe(""));
  });

  // The margin is reserved for the whole session, not just while a labelled
  // guide is actually on screen - otherwise choosing one would narrow the
  // image at the exact moment someone is looking at it
  it("reserves the guide-label margin before a crop is chosen", async () => {
    setup();
    await ready();

    expect(document.querySelector(".CropStep-roomy")).not.toBeNull();
  });
});

// Scenes and studios carry no image types today, so no crop_template can ever
// be selected - which is also the state before the image has finished
// decoding, so this is what tells the two apart
describe("CropStep with nothing to crop to", () => {
  it("says nothing about picking a crop", async () => {
    render(<CropStep file={file()} groups={[]} onUpload={vi.fn()} />);

    await waitFor(() =>
      expect(document.querySelector(".CropFrame")).not.toBeNull(),
    );
    expect(document.querySelector(".CropStep-template")).toBeNull();
  });

  // No template ever has guides to make room for, so reserving the margin
  // for the whole session would only narrow the picture for nothing
  it("does not reserve room for a guide label that can never appear", async () => {
    render(<CropStep file={file()} groups={[]} onUpload={vi.fn()} />);

    await waitFor(() =>
      expect(document.querySelector(".CropFrame")).not.toBeNull(),
    );
    expect(document.querySelector(".CropStep-roomy")).toBeNull();
  });
});

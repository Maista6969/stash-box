import { useLens } from "@hookform/lenses";
import { screen, waitFor } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { type FC, useState } from "react";
import { useForm } from "react-hook-form";
import {
  CropGuideAxisEnum,
  CropGuideRoleEnum,
  ImageTypeEnum,
  ImageTypeGroupEnum,
  ImageTypeScopeEnum,
} from "src/graphql";
import ImageTypeGroupsGQL from "src/graphql/queries/ImageTypeGroups.gql";
import { renderForm } from "src/test/renderForm";
import { describe, expect, it } from "vitest";

import EditImages from "../editImages";
import type { TypedImage } from "../types";

/**
 * An image that already exists on the performer, already labelled, opened in
 * the lightbox without editing anything. That is where the guides earn their
 * keep: a template says where the eyes should sit, and there is otherwise no
 * way to see whether they do.
 */

const guides = [
  {
    __typename: "CropGuide" as const,
    axis: CropGuideAxisEnum.Y,
    position: 0.425,
    role: CropGuideRoleEnum.ANCHOR,
    label: "Bisects the eyes",
    pivot: false,
  },
  {
    __typename: "CropGuide" as const,
    axis: CropGuideAxisEnum.X,
    position: 0.5,
    role: CropGuideRoleEnum.REFERENCE,
    label: "Centre",
    pivot: false,
  },
];

const vocabularyMock = {
  request: {
    query: ImageTypeGroupsGQL,
    variables: {
      target: ImageTypeScopeEnum.PERFORMER,
      includeDisabled: true,
    },
  },
  maxUsageCount: Number.POSITIVE_INFINITY,
  result: {
    data: {
      imageTypeGroups: [
        {
          __typename: "ImageTypeGroup" as const,
          key: ImageTypeGroupEnum.CROP,
          name: "Crop",
          description: null,
          enabled: true,
          types: [
            {
              __typename: "ImageType" as const,
              key: ImageTypeEnum.CROP_FACE,
              name: "Face",
              description: null,
              enabled: true,
              conflicts_with: [],
              crop_template: {
                __typename: "CropTemplate" as const,
                aspect_ratio: 2 / 3,
                guides,
                shapes: [],
              },
            },
            {
              __typename: "ImageType" as const,
              key: ImageTypeEnum.CROP_TORSO,
              name: "Torso",
              description: null,
              enabled: true,
              conflicts_with: [],
              crop_template: null,
            },
          ],
        },
      ],
    },
  },
};

const image = (id: string, types: ImageTypeEnum[]): TypedImage => ({
  image: {
    __typename: "Image" as const,
    id,
    url: `https://example.com/${id}.jpg`,
    width: 800,
    height: 1200,
  },
  types,
  date: null,
});

const Harness: FC<{ images: TypedImage[] }> = ({ images }) => {
  const { control } = useForm<{ images: TypedImage[] }>({
    defaultValues: { images },
  });
  const lens = useLens({ control });

  return (
    <EditImages
      lens={lens.focus("images").cast<TypedImage[]>()}
      file={undefined}
      setFile={() => {}}
      target={ImageTypeScopeEnum.PERFORMER}
    />
  );
};

// A harness that manages file selection itself, for the tests below that need
// to remove or upload it -- unlike Harness above, which never has one.
const Uploading: FC<{ file: File; target?: ImageTypeScopeEnum }> = ({
  file: initialFile,
  target = ImageTypeScopeEnum.PERFORMER,
}) => {
  const [file, setFile] = useState<File | undefined>(initialFile);
  const { control } = useForm<{ images: TypedImage[] }>({
    defaultValues: { images: [] },
  });
  const lens = useLens({ control });

  return (
    <EditImages
      lens={lens.focus("images").cast<TypedImage[]>()}
      file={file}
      setFile={setFile}
      target={target}
    />
  );
};

// Scenes carry no image types today, so this is what every entity but
// performer actually gets back.
const sceneVocabularyMock = {
  request: {
    query: ImageTypeGroupsGQL,
    variables: {
      target: ImageTypeScopeEnum.SCENE,
      includeDisabled: true,
    },
  },
  maxUsageCount: Number.POSITIVE_INFINITY,
  result: { data: { imageTypeGroups: [] } },
};

// The lightbox is a modal and renders into a portal, so it is not inside the
// render container.
const drawn = () => document.querySelectorAll(".CropOverlay-guide");

const open = async (user: ReturnType<typeof userEvent.setup>) => {
  const [thumbnail] = screen.getAllByRole("button", { name: /image/i });
  await user.click(thumbnail);
};

describe("EditImages lightbox guides", () => {
  it("draws the frame an existing image already claims", async () => {
    const { user } = renderForm(
      <Harness images={[image("a", [ImageTypeEnum.CROP_FACE])]} />,
      { mocks: [vocabularyMock] },
    );

    await open(user);

    // Off until asked for: the lightbox is for looking at the photograph.
    const toggle = await screen.findByRole("button", { name: "Show guides" });
    expect(drawn()).toHaveLength(0);

    await user.click(toggle);

    await waitFor(() => expect(drawn()).toHaveLength(guides.length));
    expect(screen.getByText("Bisects the eyes")).toBeInTheDocument();
  });

  // No toggle where there is nothing to toggle, which is the assertion that
  // means something now that guides start hidden either way.
  it("offers nothing to show for an image with no crop", async () => {
    const { user } = renderForm(<Harness images={[image("a", [])]} />, {
      mocks: [vocabularyMock],
    });

    await open(user);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /guides/i })).toBeNull();
  });

  // A crop the instance has no template for is a label, not a frame.
  it("offers nothing to show for a crop with no template", async () => {
    const { user } = renderForm(
      <Harness images={[image("a", [ImageTypeEnum.CROP_TORSO])]} />,
      { mocks: [vocabularyMock] },
    );

    await open(user);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /guides/i })).toBeNull();
  });
});

// Remove and Upload used to live inside CropStep, in a row of their own,
// right-aligned to share an edge with Reset Images below rather than a row
// with it. That put master's Remove and Upload on a different line from
// Reset Images; this is the row master had them all on.
describe("EditImages action row", () => {
  const pending = () =>
    new File(["pixels"], "photo.jpg", { type: "image/jpeg" });

  it("puts Remove and Upload on Reset Images' row", async () => {
    renderForm(<Uploading file={pending()} />, { mocks: [vocabularyMock] });

    await screen.findByLabelText("Add label");

    const row = screen.getByRole("button", { name: "Remove" }).parentElement;
    expect(row).toBe(
      screen.getByRole("button", { name: "Reset Images" }).parentElement,
    );
    expect(row).toContainElement(
      screen.getByRole("button", { name: "Upload" }),
    );
  });

  it("drops the file when Remove is clicked", async () => {
    const { user } = renderForm(<Uploading file={pending()} />, {
      mocks: [vocabularyMock],
    });

    await screen.findByLabelText("Add label");
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText("Add image")).toBeInTheDocument();
  });
});

// The gallery gives up width to the crop frame while a file is staged, which
// is new since master and worth the gallery being narrower -- but only where
// there is a frame to give it to.
describe("EditImages column width", () => {
  const pending = () =>
    new File(["pixels"], "photo.jpg", { type: "image/jpeg" });

  const inputCol = () =>
    document.querySelector(".EditImages-input") as HTMLElement;

  it("widens the input column where there is a frame to give room to", async () => {
    renderForm(<Uploading file={pending()} />, { mocks: [vocabularyMock] });

    await screen.findByLabelText("Add label");

    expect(inputCol().className).toContain("col-8");
  });

  // Scenes and studios carry no image types today, so staging a file is the
  // plain preview-and-upload master had, which fits master's column widths.
  it("keeps master's width where there is nothing to crop", async () => {
    renderForm(
      <Uploading file={pending()} target={ImageTypeScopeEnum.SCENE} />,
      { mocks: [sceneVocabularyMock] },
    );

    await waitFor(() =>
      expect(document.querySelector(".CropFrame")).not.toBeNull(),
    );

    expect(inputCol().className).toContain("col-5");
  });

  // Remove/Reset/Upload sit in their own row below CropStep rather than
  // inside it, so nothing connects their indent to CropStep's own
  // -roomy padding except this class living on the same condition.
  // Mismatched, the buttons sit under the column's left edge while the
  // picture and its labels sit indented under $crop-gutter beside them.
  it("indents the action row exactly when CropStep reserves guide-label room", async () => {
    renderForm(<Uploading file={pending()} />, { mocks: [vocabularyMock] });

    await screen.findByLabelText("Add label");

    expect(document.querySelector(".CropStep-roomy")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove" }).parentElement?.className,
    ).toContain("EditImages-actions-roomy");
  });

  it("does not indent the action row where CropStep has no room reserved", async () => {
    renderForm(
      <Uploading file={pending()} target={ImageTypeScopeEnum.SCENE} />,
      { mocks: [sceneVocabularyMock] },
    );

    await waitFor(() =>
      expect(document.querySelector(".CropFrame")).not.toBeNull(),
    );

    expect(document.querySelector(".CropStep-roomy")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove" }).parentElement?.className,
    ).not.toContain("EditImages-actions-roomy");
  });
});

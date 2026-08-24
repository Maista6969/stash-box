import { CombinedGraphQLErrors } from "@apollo/client";
import { faImages } from "@fortawesome/free-solid-svg-icons";
import type { Lens } from "@hookform/lenses";
import cx from "classnames";
import { type ChangeEvent, type FC, useRef, useState } from "react";
import { Button, Col, Form, Row } from "react-bootstrap";
import { useFieldArray } from "react-hook-form";
import { Image as ImageInput } from "src/components/form";
import { Icon } from "src/components/fragments";
import {
  type ImageCropInput,
  type ImageTypeEnum,
  type ImageTypeScopeEnum,
  useAddImage,
  useImageTypeGroups,
} from "src/graphql";

import CropStep, { type CropStepHandle } from "./CropStep";
import ImageLabels from "./ImageLabels";
import type { TypedImage } from "./types";

const CLASSNAME = "EditImages";
const CLASSNAME_IMAGES = `${CLASSNAME}-images`;
const CLASSNAME_INPUT = `${CLASSNAME}-input`;
const CLASSNAME_INPUT_CONTAINER = `${CLASSNAME_INPUT}-container`;
const CLASSNAME_DROP = `${CLASSNAME}-drop`;
const CLASSNAME_PLACEHOLDER = `${CLASSNAME}-placeholder`;
const CLASSNAME_IMAGE_ENTRY = `${CLASSNAME}-image-entry`;

interface EditImagesProps {
  lens: Lens<TypedImage[]>;
  file: File | undefined;
  setFile: (f: File | undefined) => void;
  maxImages?: number;
  /** Whether to allow svg/png image input */
  allowLossless?: boolean;
  original?: TypedImage[] | undefined;
  /**
   * Which entity kind these images belong to. Types that entity cannot carry
   * are filtered out, so scenes and studios show no label controls until their
   * taxonomies ship.
   */
  target: ImageTypeScopeEnum;
}

const EditImages: FC<EditImagesProps> = ({
  lens,
  maxImages,
  file,
  setFile,
  allowLossless = false,
  original,
  target,
}) => {
  const interop = lens.interop();
  const {
    fields: images,
    append,
    remove,
    replace,
    update,
  } = useFieldArray({
    control: interop.control,
    name: interop.name,
    keyName: "key",
  });

  const { data: vocabulary } = useImageTypeGroups({
    target,
    // We need to include disabled labels so they can be seen and removed
    includeDisabled: true,
  });
  const groups = vocabulary?.imageTypeGroups ?? [];

  // This decides whether or not we offer the labeling controls
  const labellable = groups.some((group) => group.types.length > 0);

  const typeName = (key: string) =>
    groups.flatMap((group) => group.types).find((type) => type.key === key)
      ?.name ?? key;

  const labels = Object.fromEntries(
    images
      .filter((i) => i.types.length > 0 || i.date)
      .map((i) => [
        i.image.id,
        [...i.types.map(typeName), ...(i.date ? [i.date] : [])],
      ]),
  );

  // The frame each image claims, so the lightbox can hold a picture against the
  // template it says it follows and say when the two disagree. Read from form
  // state like the labels are, so choosing a Crop takes effect without waiting
  // for a round trip
  //
  // At most one applies: crops are an exclusive group, so an image cannot claim
  // two templates, and the first match is the only match
  const templates = new Map(
    groups
      .flatMap((group) => group.types)
      .flatMap((type) =>
        type.crop_template
          ? [
              [
                type.key,
                {
                  aspectRatio: type.crop_template.aspect_ratio,
                  guides: type.crop_template.guides,
                  shapes: type.crop_template.shapes,
                },
              ] as const,
            ]
          : [],
      ),
  );
  const cropTemplates = Object.fromEntries(
    images.flatMap((i) => {
      const claimed = i.types.map((t) => templates.get(t)).find(Boolean);
      return claimed ? [[i.image.id, claimed] as const] : [];
    }),
  );

  const [uploading, setUploading] = useState(false);
  const [addImage] = useAddImage();
  const [error, setError] = useState<string>();
  // Whether the pending upload is a crop, so the Upload button below - which
  // does not know that on its own, since CropStep keeps the frame to itself
  // - can call itself "Crop and upload" and offer Reset.
  const [crops, setCrops] = useState(false);
  const cropStep = useRef<CropStepHandle>(null);

  // The crop and the label are chosen in one action, so the type arrives here
  // already true of the image rather than as something to judge afterwards
  const handleAddImage = (
    crop: ImageCropInput | undefined,
    types: ImageTypeEnum[],
    imageDate: string | null,
  ) => {
    setError("");
    setUploading(true);
    addImage({
      variables: {
        imageData: { file, crop },
      },
    })
      .then((i) => {
        if (i.data?.imageCreate?.id) {
          if (
            !images.some((image) => image.image.id === i.data?.imageCreate?.id)
          ) {
            append({
              image: i.data.imageCreate,
              types,
              date: imageDate,
            });
          }
          setFile(undefined);
          setCrops(false);
        }
      })
      .catch((error: unknown) => {
        if (CombinedGraphQLErrors.is(error)) setError(error.message);
      })
      .finally(() => {
        setUploading(false);
      });
  };

  const removeImage = () => {
    setFile(undefined);
    setCrops(false);
    setError("");
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.validity.valid && event.target.files?.[0]) {
      setFile(event.target.files[0]);
      setError("");
    }
  };

  const isDisabled = maxImages !== undefined && images.length >= maxImages;

  // Only true for images that can have labels and crop controls
  const wantsRoom = file !== undefined && templates.size > 0;

  return (
    <Row className={`${CLASSNAME} w-100`}>
      {/* Cropping wants room -- rotating and dragging a frame in a narrow
          column is fiddly work. The gallery gives some up while a file is
          staged and takes it back afterwards, which costs nothing: nobody is
          browsing the gallery mid-upload. */}
      <Col xs={wantsRoom ? 4 : 7} className={CLASSNAME_IMAGES}>
        {images.map((i, index) => (
          <div className={CLASSNAME_IMAGE_ENTRY} key={i.image.id}>
            <ImageInput
              image={i.image}
              lightboxImages={images.map((image) => image.image)}
              onRemove={() => remove(index)}
              lightboxProps={{
                labels,
                cropTemplates,
                renderEditor: labellable
                  ? (image) => {
                      const position = images.findIndex(
                        (candidate) => candidate.image.id === image.id,
                      );
                      if (position < 0) return null;

                      // Drop the key, it does not need to be propagated
                      const { key: _key, ...current } = images[position];

                      return (
                        <ImageLabels
                          groups={groups}
                          value={current}
                          onChange={(value) => update(position, value)}
                        />
                      );
                    }
                  : undefined,
              }}
            />
          </div>
        ))}
      </Col>
      <Col xs={wantsRoom ? 8 : 5} className={CLASSNAME_INPUT}>
        <div className={CLASSNAME_INPUT_CONTAINER}>
          {file ? (
            <CropStep
              ref={cropStep}
              file={file}
              groups={groups}
              onCropsChange={setCrops}
              onUpload={handleAddImage}
            />
          ) : (
            !isDisabled && (
              <div className={CLASSNAME_DROP}>
                <Form.Control
                  type="file"
                  onChange={onFileChange}
                  accept={[
                    ".jpg",
                    ".jpeg",
                    ".webp",
                    ".jfif",
                    ...(allowLossless ? [".svg", ".png"] : []),
                  ].join(",")}
                />
                <div className={CLASSNAME_PLACEHOLDER}>
                  <Icon icon={faImages} />
                  <span>Add image</span>
                </div>
              </div>
            )
          )}
        </div>
        {error && <div className="text-danger text-end">{error}</div>}
        <div
          className={cx("mt-4 d-flex", {
            [`${CLASSNAME}-actions-roomy`]: wantsRoom,
          })}
        >
          {file && (
            <>
              <Button
                variant="danger"
                onClick={removeImage}
                disabled={uploading}
              >
                Remove
              </Button>

              {/*
                Only once something has been done to the picture. Reset puts
                it back to the untouched file, so changing your mind is Reset
                and then Upload -- the same two words, in the same places, as
                before any of this existed.
              */}
              {crops && (
                <Button
                  variant="secondary"
                  onClick={() => cropStep.current?.reset()}
                  disabled={uploading}
                  className="ms-2"
                >
                  Reset
                </Button>
              )}

              <Button
                onClick={() => cropStep.current?.upload()}
                disabled={uploading}
                className="ms-2"
              >
                {uploading
                  ? "Uploading..."
                  : crops
                    ? "Crop and upload"
                    : "Upload"}
              </Button>
            </>
          )}
          <Button
            variant="danger"
            onClick={() => original && replace(original)}
            disabled={original === undefined}
            className="ms-auto mt-auto"
          >
            Reset Images
          </Button>
        </div>
      </Col>
    </Row>
  );
};

export default EditImages;

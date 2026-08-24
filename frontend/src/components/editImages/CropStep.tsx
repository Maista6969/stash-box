import cx from "classnames";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import CropFrame, {
  type CropRect,
  FULL_FRAME,
  isIdentity,
  largestCenteredRect,
  rotatedSize,
} from "src/components/cropFrame";
import { LoadingIndicator } from "src/components/fragments";
import type {
  ImageCropInput,
  ImageTypeEnum,
  ImageTypeGroupsQuery,
} from "src/graphql";

import ImageLabels from "./ImageLabels";

type ImageTypeGroup = ImageTypeGroupsQuery["imageTypeGroups"][number];

const CLASSNAME = "CropStep";

interface CropStepProps {
  file: File;
  groups: ImageTypeGroup[];
  onCropsChange?: (crops: boolean) => void;
  onUpload: (
    crop: ImageCropInput | undefined,
    types: ImageTypeEnum[],
    imageDate: string | null,
  ) => void;
}

export interface CropStepHandle {
  upload: () => void;
  reset: () => void;
}

/**
 * The step between choosing a file and uploading it: pick the crop this image
 * is meant to be, drag its frame over the picture, send both
 *
 * The frame and the label are chosen in one action, which is the point: a Crop
 * value applied afterwards is a judgement about a photograph but the one applied
 * here is a description of what was just done to it, and true by construction.
 *
 * Cropping is never required. Doing nothing leaves a plain "Upload", exactly
 * as before any of this existed, because there are uploads no frame suits like a
 * close-up of a tattoo or a more artistic image from social media
 */
const CropStep = forwardRef<CropStepHandle, CropStepProps>(function CropStep(
  { file, groups, onCropsChange, onUpload },
  ref,
) {
  const [src, setSrc] = useState<string>();
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [failed, setFailed] = useState(false);
  const [rect, setRect] = useState<CropRect>(FULL_FRAME);
  // Everything this image is being called, crop included. Shaped like a gallery
  // image so the same control serves both
  const [labels, setLabels] = useState<{
    types: ImageTypeEnum[];
    date?: string | null;
  }>({ types: [], date: null });

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setFailed(false);

    let live = true;
    createImageBitmap(file, { imageOrientation: "from-image" })
      .then((bitmap) => {
        if (live) setSize({ width: bitmap.width, height: bitmap.height });
        bitmap.close();
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // Any type the instance has a template for, rather than anything matching a
  // name: an instance that added a crop of its own gets a frame for it, and one
  // that removed a template stops being offered that frame
  const templates = useMemo(
    () => groups.flatMap((group) => group.types).filter((t) => t.crop_template),
    [groups],
  );

  const selected = templates.find((t) => labels.types.includes(t.key));
  const aspectRatio = selected?.crop_template?.aspect_ratio;
  const guides = selected?.crop_template?.guides ?? [];
  const shapes = selected?.crop_template?.shapes ?? [];

  // Choosing a different crop means a different shape, so the frame starts
  // again at the largest one that fits rather than being squeezed out of the
  // old one
  useEffect(() => {
    if (!size) return;
    setRect((previous) => {
      const turned = rotatedSize(size.width, size.height, previous.angle);
      return largestCenteredRect(
        aspectRatio,
        turned.width / turned.height,
        previous.angle,
      );
    });
  }, [aspectRatio, size]);

  // Whether cropping would do anything. Choosing a frame that happens to select
  // the whole picture is not a crop, and the server would skip it too, so the
  // form does not offer to
  const crops = !isIdentity(rect);

  useEffect(() => {
    onCropsChange?.(crops);
  }, [crops, onCropsChange]);

  // Back to the untouched file: no frame, no rotation, nothing cropped. The
  // other labels stay, since they describe the photograph rather than what was
  // done to it here
  const reset = () => {
    setLabels((previous) => ({
      ...previous,
      types: previous.types.filter(
        (type) => !templates.some((template) => template.key === type),
      ),
    }));
    setRect(FULL_FRAME);
  };

  const upload = () =>
    onUpload(
      crops
        ? {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            angle: rect.angle,
          }
        : undefined,
      // The crop type is a label whether or not the frame cut anything: an
      // image already the right shape is still that kind of picture
      labels.types,
      labels.date ?? null,
    );

  useImperativeHandle(ref, () => ({ upload, reset }));

  return (
    <div
      className={cx(CLASSNAME, {
        [`${CLASSNAME}-roomy`]: templates.length > 0,
      })}
    >
      {src && size && !failed ? (
        <>
          {templates.length > 0 && (
            <p className={`${CLASSNAME}-template`}>
              {selected ? (
                <span className={`${CLASSNAME}-template-name`}>
                  <strong>{selected.name}</strong>
                  {selected.description ? ` -- ${selected.description}` : ""}
                </span>
              ) : (
                <span
                  className={`${CLASSNAME}-template-name ${CLASSNAME}-template-empty`}
                >
                  Pick a crop below to frame this image against its template.
                </span>
              )}

              {selected && (
                <a
                  className={`${CLASSNAME}-template-link`}
                  href={`/crop-templates/${selected.key}`}
                  download
                  rel="noreferrer"
                >
                  Download template
                </a>
              )}
            </p>
          )}

          <CropFrame
            src={src}
            naturalWidth={size.width}
            naturalHeight={size.height}
            aspectRatio={aspectRatio ?? undefined}
            guides={guides}
            shapes={shapes}
            value={rect}
            onChange={setRect}
          />
        </>
      ) : (
        <div className={`${CLASSNAME}-loading`}>
          {failed ? (
            <span>This file cannot be cropped. Upload it as it is.</span>
          ) : (
            <LoadingIndicator message="Reading image..." />
          )}
        </div>
      )}

      {groups.some((group) => group.types.length > 0) && (
        <div className={`${CLASSNAME}-labels`}>
          <ImageLabels groups={groups} value={labels} onChange={setLabels} />
        </div>
      )}
    </div>
  );
});

export default CropStep;

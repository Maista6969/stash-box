import { faXmark } from "@fortawesome/free-solid-svg-icons";
import cx from "classnames";
import {
  type CSSProperties,
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { Button, Modal } from "react-bootstrap";
import {
  CropOverlay,
  type CropTemplateInfo,
  largestCenteredRect,
  matchesAspect,
} from "src/components/cropFrame";
import { Icon } from "src/components/fragments";
import type { CropGuide, CropShape } from "src/graphql";
import Image from "./Image";

type LightboxImage = {
  id: string;
  url: string;
  width: number;
  height: number;
};

interface ImageLightboxProps {
  images: LightboxImage[];
  defaultIndex?: number;
  onClose: () => void;
  labels?: Record<string, string[]>;
  /**
   * The crop template each image claims to follow, keyed by image id. Its
   * guides are drawn over the focused image, and its aspect ratio is what the
   * dimensions are checked against
   */
  cropTemplates?: Record<string, CropTemplateInfo>;
  /**
   * Turns the lightbox into an editor for the focused image: one image large
   * enough to judge, the rest a click away, and controls belonging to exactly
   * one image rather than repeated down a grid
   */
  renderEditor?: (image: LightboxImage) => ReactNode;
}

const Labels: FC<{ labels?: string[] }> = ({ labels }) =>
  labels?.length ? (
    <span className="ImageLightbox-labels">
      {labels.map((label) => (
        <span key={label} className="ImageLightbox-label">
          {label}
        </span>
      ))}
    </span>
  ) : null;

/**
 * Draws a template's geometry over the picture, not over the box the picture
 * sits in.
 *
 * The two are not the same. `.Image` carries the image's aspect ratio, but the
 * lightbox column constrains it on both axes, and when the constraint that
 * binds is the one the ratio did not choose the box comes out a different shape
 * from the picture. `object-fit: contain` then letterboxes the picture inside
 * it, and an overlay drawn at 100% of the box reaches past the photograph --
 * differently at every viewport size, which is worse than being wrong
 * consistently
 *
 * So the box is measured and the picture's own rectangle computed from it,
 * which is the same arithmetic `object-fit: contain` does. The overlay is then
 * placed on that rectangle and fitted within it as usual
 */
const FittedOverlay: FC<{
  guides: CropGuide[];
  shapes: CropShape[];
  templateAspect: number;
  imageAspect: number;
}> = ({ guides, shapes, templateAspect, imageAspect }) => {
  const [boxAspect, setBoxAspect] = useState<number>();

  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;

    // Read once, here, rather than waiting for the observer's first callback.
    // Ref callbacks run during commit, so this lands before the browser paints;
    // ResizeObserver delivers asynchronously, which paints one frame of the
    // fallback first. Stepping through a gallery remounts this component every
    // time (the lightbox keys its image on the url) so that frame is not a
    // one-off at startup, it flashes on every image
    const { width, height } = el.getBoundingClientRect();
    if (width > 0 && height > 0) setBoxAspect(width / height);

    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      if (box.width > 0 && box.height > 0) setBoxAspect(box.width / box.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const picture = largestCenteredRect(imageAspect, boxAspect ?? imageAspect);

  return (
    <div className="ImageLightbox-overlay-box" ref={measure}>
      <div
        style={{
          position: "absolute",
          left: `${picture.x * 100}%`,
          top: `${picture.y * 100}%`,
          width: `${picture.width * 100}%`,
          height: `${picture.height * 100}%`,
          visibility: boxAspect === undefined ? "hidden" : undefined,
        }}
      >
        <CropOverlay
          guides={guides}
          shapes={shapes}
          fit={{ templateAspect, imageAspect }}
        />
      </div>
    </div>
  );
};

const ImageLightbox: FC<ImageLightboxProps> = ({
  images,
  defaultIndex = 0,
  onClose,
  cropTemplates,
  labels,
  renderEditor,
}) => {
  const [index, setIndex] = useState(defaultIndex);
  const [showGuides, setShowGuides] = useState(false);

  const focused = images[Math.min(index, images.length - 1)];
  const template = cropTemplates?.[focused?.id];
  const focusedGuides = template?.guides ?? [];
  const focusedShapes = template?.shapes ?? [];

  const hasOverlay = focusedGuides.length > 0 || focusedShapes.length > 0;

  // Checked against the template the image claims rather than against a fixed
  // 2:3, so an instance with its own templates gets an answer about its own
  // rules. Aspect only, resolution is not policed
  const offAspect =
    template !== undefined &&
    !matchesAspect(focused.width, focused.height, template.aspectRatio);

  // Unusable dimensions mean no frame can be placed: an SVG stores -1 for both,
  // and inventing one would be worse than leaving the geometry where it is
  const overlayFit =
    template !== undefined && focused.width > 0 && focused.height > 0
      ? {
          templateAspect: template.aspectRatio,
          imageAspect: focused.width / focused.height,
        }
      : undefined;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // We don't want an arrow key to move to the next image if it's inside of the date input for example
      if (
        e.target instanceof Element &&
        e.target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }

      if (e.key === "ArrowRight")
        setIndex((i) => Math.min(i + 1, images.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [images.length]);

  const scrollIntoView = useCallback(
    (el: HTMLButtonElement | null) => el?.scrollIntoView({ block: "nearest" }),
    [],
  );

  // Close on background clicks, but not on the image, caption or thumbs
  const closeOnBackgroundClick = (e: React.MouseEvent) => {
    if (
      e.target instanceof HTMLElement &&
      (e.target === e.currentTarget ||
        e.target.classList.contains("ImageLightbox-main") ||
        e.target.classList.contains("ImageLightbox-thumbs"))
    )
      onClose();
  };

  // Scale thumbnails to the collection: few images get large thumbs,
  // large collections get a compact grid.
  const thumbHeight =
    images.length <= 4 ? 300 : images.length <= 12 ? 220 : 160;

  return (
    <Modal show fullscreen onHide={onClose} dialogClassName="ImageLightbox">
      <Modal.Body onClick={closeOnBackgroundClick}>
        <div
          className={cx("ImageLightbox-main", {
            "ImageLightbox-main-guided": hasOverlay,
          })}
        >
          <Image
            images={focused}
            key={focused.url}
            size="full"
            // No need to show labels as overlays if they're already being shown
            // as tag chips above the select input
            overlay={
              <>
                {!renderEditor && <Labels labels={labels?.[focused.id]} />}
                {showGuides && hasOverlay && overlayFit && (
                  <FittedOverlay
                    guides={focusedGuides}
                    shapes={focusedShapes}
                    templateAspect={overlayFit.templateAspect}
                    imageAspect={overlayFit.imageAspect}
                  />
                )}
              </>
            }
          />
          <span className="ImageLightbox-caption">
            {images.length > 1 && (
              <>
                {index + 1}/{images.length} &middot;{" "}
              </>
            )}
            {focused.width}&times;{focused.height}
            {offAspect && (
              <span
                className="ImageLightbox-off-aspect"
                title="These proportions do not match the crop this image is labelled with"
              >
                {" "}
                &middot; off frame
              </span>
            )}
            {hasOverlay && (
              <>
                {" "}
                &middot;{" "}
                <Button
                  className="ImageLightbox-guide-toggle minimal"
                  variant="link"
                  aria-pressed={showGuides}
                  onClick={() => setShowGuides((shown) => !shown)}
                >
                  {showGuides ? "Hide guides" : "Show guides"}
                </Button>
              </>
            )}
          </span>
          {renderEditor && (
            <div
              className="ImageLightbox-editor"
              role="group"
              aria-label="Edit this image"
            >
              {renderEditor(focused)}
            </div>
          )}
        </div>
        {images.length > 1 && (
          <div
            className="ImageLightbox-thumbs"
            style={{ "--thumb-height": `${thumbHeight}px` } as CSSProperties}
          >
            {images.map((image, i) => (
              <button
                type="button"
                key={image.id}
                ref={i === index ? scrollIntoView : undefined}
                className={cx("ImageLightbox-thumb", {
                  selected: i === index,
                })}
                style={{ aspectRatio: `${image.width} / ${image.height}` }}
                onClick={() => setIndex(i)}
              >
                <img src={`${image.url}?size=300`} loading="lazy" alt="" />
                {renderEditor && (
                  <span className="ImageLightbox-thumb-labels">
                    <Labels labels={labels?.[image.id]} />
                  </span>
                )}
                <span className="ImageLightbox-thumb-dims">
                  {image.width}&times;{image.height}
                </span>
              </button>
            ))}
          </div>
        )}
        <Button
          className="ImageLightbox-close minimal"
          onClick={onClose}
          variant="link"
        >
          <Icon icon={faXmark} />
        </Button>
      </Modal.Body>
    </Modal>
  );
};

export default ImageLightbox;

import cx from "classnames";
import {
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Form } from "react-bootstrap";
import type { CropGuide, CropShape } from "src/graphql";

import CropOverlay from "./CropOverlay";
import {
  type CropRect,
  cropPixels,
  type Handle,
  type HoldPoints,
  isRoundSize,
  moveRect,
  refitRect,
  resizeRect,
  rotatedSize,
} from "./geometry";
import { holdPointsFor } from "./holds";

const CLASSNAME = "CropFrame";
const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];

const MAX_ANGLE = 90;

const suspendsSnapping = (event: ReactPointerEvent<HTMLElement>) =>
  event.ctrlKey || event.metaKey;

const SUSPEND_KEY =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl";

interface CropFrameProps {
  /** Object URL of the image being cropped */
  src: string;
  /** Natural size of that image, before any rotation */
  naturalWidth: number;
  naturalHeight: number;
  /** Width over height to lock the frame to, or undefined to drag freely */
  aspectRatio?: number;
  guides?: CropGuide[];
  /** Outlines the template draws, if it has any */
  shapes?: CropShape[];
  value: CropRect;
  onChange: (rect: CropRect) => void;
}

/**
 * An aspect-locked frame dragged over an image, with the chosen template's
 * guides drawn inside it
 *
 * Presentational and controlled: the frame is described entirely by `value`,
 * in fractions of the rotated image, which is exactly what the server accepts.
 * Nothing here reads or writes a file because cropping happens on the server, and
 * what this produces is the rectangle describing it
 */
const CropFrame: FC<CropFrameProps> = ({
  src,
  naturalWidth,
  naturalHeight,
  aspectRatio,
  guides = [],
  shapes = [],
  value,
  onChange,
}) => {
  const stage = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Which lines the current drag is holding, for the overlay to mark:
  // this is only set while a Shift-resize is under way
  const [held, setHeld] = useState<HoldPoints>();
  const [shiftDown, setShiftDown] = useState(false);

  // Shift shows what a resize would pivot about before the press
  useEffect(() => {
    const track = (event: KeyboardEvent) => setShiftDown(event.shiftKey);
    // Blur too: tabbing away with the key down never delivers the keyup, and
    // the cue would sit there marking a line nothing is holding
    const clear = () => setShiftDown(false);

    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // During a drag the lines are whatever was read at the press, which cannot
  // change halfway through. Outside one, Shift previews what a press would
  // hold, but never during a drag that did not start with it. Otherwise pressing
  // the key mid-drag would promise an anchoring that is not happening
  const previewed = useMemo(() => holdPointsFor(guides), [guides]);
  const marked = held ?? (shiftDown && !dragging ? previewed : undefined);

  // The stage is the rotated image's bounding box, which is what the frame's
  // fractions are measured against. Rotation grows it, matching what the
  // server does, so the frame the contributor drags is the frame that gets cut
  const rotated = rotatedSize(naturalWidth, naturalHeight, value.angle);
  const imageAspect = rotated.width / rotated.height;

  // Mirrors the server's rounding, so the number on screen is the number that comes back
  const output = cropPixels(value, naturalWidth, naturalHeight);

  const drag = useCallback(
    (
      event: ReactPointerEvent<HTMLElement>,
      apply: (dx: number, dy: number) => CropRect,
    ) => {
      const box = stage.current?.getBoundingClientRect();
      if (!box || box.width === 0 || box.height === 0) return;

      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      setDragging(true);

      const startX = event.clientX;
      const startY = event.clientY;

      const move = (moveEvent: PointerEvent) => {
        // Deltas from the press rather than from the last event: accumulating
        // per-move deltas drifts, because each one is clamped on the way in
        onChange(
          apply(
            (moveEvent.clientX - startX) / box.width,
            (moveEvent.clientY - startY) / box.height,
          ),
        );
      };

      const done = () => {
        target.releasePointerCapture(event.pointerId);
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", done);
        target.removeEventListener("pointercancel", done);
        setDragging(false);
        setHeld(undefined);
      };

      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", done);
      target.addEventListener("pointercancel", done);
    },
    [onChange],
  );

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    const from = value;
    drag(event, (dx, dy) => moveRect(from, dx, dy));
  };

  const startResize = (
    event: ReactPointerEvent<HTMLElement>,
    handle: Handle,
  ) => {
    const from = value;
    const hold = event.shiftKey ? holdPointsFor(guides) : undefined;
    setHeld(hold);

    // Snapping is on unless suspended, which is the way every editor that has
    // it works: Photoshop, Figma and Inkscape all snap by default and give you
    // a key to hold when you want the tool to stop helping
    const canvasWidth = suspendsSnapping(event) ? undefined : rotated.width;

    drag(event, (dx, dy) =>
      resizeRect({
        rect: from,
        handle,
        dx,
        dy,
        targetAspect: aspectRatio,
        imageAspect,
        hold,
        // Snapping is in pixels so the resize needs to know how
        // many the frame is measured against
        canvasWidth,
      }),
    );
  };

  // Turning reshapes the stage, so a frame that fitted a moment ago may not
  // now: refitting keeps its centre, because that is where the subject is
  const setAngle = (angle: number) => {
    const turned = rotatedSize(naturalWidth, naturalHeight, angle);
    onChange(
      refitRect({ ...value, angle }, aspectRatio, turned.width / turned.height),
    );
  };

  // Arrow keys nudge the frame. Dragging is pointer-only otherwise, and a
  // fine adjustment is easier to make a keypress at a time than by hand
  const nudge = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 0.05 : 0.005;
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = by[event.key];
    if (!delta) return;

    event.preventDefault();
    onChange(moveRect(value, delta[0], delta[1]));
  };

  // With no template there is no shape to hold and no line to line anything up
  // against, so the frame is not drawn at all. A border and four handles that
  // only ever select the whole picture are furniture.
  const framed = aspectRatio !== undefined;

  // Applied to both the frame and the shade behind it, which have to describe
  // the same rectangle from either side of the clip
  const frameRect = {
    left: `${value.x * 100}%`,
    top: `${value.y * 100}%`,
    width: `${value.width * 100}%`,
    height: `${value.height * 100}%`,
  };

  return (
    <div className={CLASSNAME}>
      <div
        className={`${CLASSNAME}-stage`}
        ref={stage}
        style={{
          aspectRatio: `${rotated.width} / ${rotated.height}`,
          maxWidth: `calc(var(--stage-max-height) * ${rotated.width / rotated.height})`,
        }}
      >
        <div className={`${CLASSNAME}-clip`}>
          <img
            className={`${CLASSNAME}-image`}
            src={src}
            alt=""
            draggable={false}
            style={{
              width: `${(naturalWidth / rotated.width) * 100}%`,
              height: `${(naturalHeight / rotated.height) * 100}%`,
              transform: `translate(-50%, -50%) rotate(${value.angle}deg)`,
            }}
          />
          {framed && <div className={`${CLASSNAME}-shade`} style={frameRect} />}
        </div>

        {framed && (
          <div
            className={cx(`${CLASSNAME}-frame`, {
              [`${CLASSNAME}-frame-dragging`]: dragging,
            })}
            style={frameRect}
          >
            <CropOverlay guides={guides} shapes={shapes} held={marked} />

            <button
              type="button"
              className={`${CLASSNAME}-grip`}
              aria-label="Crop frame, arrow keys to move"
              onPointerDown={startMove}
              onKeyDown={nudge}
            />

            {HANDLES.map((handle) => (
              <button
                key={handle}
                type="button"
                className={cx(
                  `${CLASSNAME}-handle`,
                  `${CLASSNAME}-handle-${handle}`,
                )}
                aria-label={`Resize ${handle}`}
                onPointerDown={(event) => startResize(event, handle)}
              />
            ))}
          </div>
        )}
      </div>

      <div className={`${CLASSNAME}-status`}>
        <p
          className={`${CLASSNAME}-hint`}
          style={framed ? undefined : { visibility: "hidden" }}
        >
          Hold{" "}
          {guides.length > 0 && (
            <>
              <kbd>Shift</kbd> to resize around the guides, or{" "}
            </>
          )}
          <kbd>{SUSPEND_KEY}</kbd> to size freely.
        </p>

        <p
          className={cx(`${CLASSNAME}-size`, {
            // Resizing pulls the frame onto round dimensions when it comes
            // close. Marking the moment it lands is what makes that legible:
            // an unannounced pull of a few pixels reads as the frame
            // disobeying rather than as the tool helping
            [`${CLASSNAME}-size-round`]: isRoundSize(
              output.width,
              output.height,
            ),
          })}
          title="Size of the finished image"
        >
          {value.angle !== 0 && "≈ "}
          {output.width} × {output.height} px
        </p>
      </div>

      {framed && (
        <Form.Group className={`${CLASSNAME}-rotate`}>
          <div className={`${CLASSNAME}-rotate-head`}>
            <Form.Label htmlFor="crop-angle">Straighten</Form.Label>
            <Button
              variant="link"
              className={`${CLASSNAME}-angle`}
              disabled={value.angle === 0}
              onClick={() => setAngle(0)}
              title="Reset rotation"
            >
              {value.angle.toFixed(1)}°
            </Button>
          </div>
          <Form.Range
            id="crop-angle"
            min={-MAX_ANGLE}
            max={MAX_ANGLE}
            step={0.1}
            value={value.angle}
            onChange={(event) => setAngle(Number(event.target.value))}
          />
        </Form.Group>
      )}
    </div>
  );
};

export default CropFrame;

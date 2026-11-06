import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";

import { Button } from "./ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "./ui/dialog";
import { useSheet } from "./ui/useSheet";

/** Return true when an image link click should open the inline preview. */
export function shouldPreviewImageAttachment(
  event: Pick<
    MouseEvent<HTMLAnchorElement>,
    | "altKey"
    | "button"
    | "ctrlKey"
    | "defaultPrevented"
    | "metaKey"
    | "shiftKey"
  >,
): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

/** One image that a preview can show. */
export type PreviewImage = {
  context?: string;
  filename: string;
  src: string;
};

function samePreviewImage(a: PreviewImage, b: PreviewImage): boolean {
  return a.src === b.src && a.filename === b.filename;
}

/**
 * Render an image attachment that opens in a responsive modal on a normal
 * click. With a gallery that holds this image, the modal pages through it.
 */
export function ImageAttachment(
  props: {
    context?: string;
    filename: string;
    gallery?: readonly PreviewImage[];
    imageClassName?: string;
    src: string;
    triggerClassName?: string;
  } & Omit<ComponentPropsWithoutRef<"img">, "alt" | "className" | "src">,
) {
  const [open, setOpen] = useState(false);
  const {
    context,
    filename,
    gallery,
    imageClassName,
    src,
    triggerClassName,
    ...imageProps
  } = props;
  const self = { context, filename, src };
  const galleryIndex =
    gallery?.findIndex((image) => samePreviewImage(image, self)) ?? -1;

  return (
    <>
      <a
        className={triggerClassName}
        href={src}
        onClick={(event) => {
          if (!shouldPreviewImageAttachment(event)) return;
          event.preventDefault();
          setOpen(true);
        }}
        rel="noreferrer"
        target="_blank"
      >
        <img
          {...imageProps}
          alt={filename}
          className={imageClassName}
          src={src}
        />
      </a>
      {open ? (
        <ImagePreview
          images={gallery && galleryIndex >= 0 ? gallery : [self]}
          initialIndex={Math.max(galleryIndex, 0)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

const PREVIEW_NAV_BUTTON_CLASS =
  "h-10 w-10 border-0 bg-transparent p-0 text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text";

/**
 * Show images above the page, one at a time. `useSheet` shares the document
 * scroll lock with sheets and keeps Escape and backdrop dismissal on the
 * front modal.
 */
function ImagePreview(props: {
  images: readonly PreviewImage[];
  initialIndex: number;
  onClose(): void;
}) {
  const sheet = useSheet(props.onClose);
  // Track the shown image, not its position. Transcript rows can load above
  // it while the preview is open, which moves its index.
  const [current, setCurrent] = useState(props.images[props.initialIndex]!);
  const count = props.images.length;
  const index = Math.max(
    props.images.findIndex((image) => samePreviewImage(image, current)),
    0,
  );
  const image = props.images[index]!;
  // Wrap at the ends. A disabled button would drop focus out of the dialog
  // and stop the arrow keys.
  const show = (next: number) =>
    setCurrent(props.images[(next + count) % count]!);

  return (
    <Dialog {...sheet.rootProps}>
      <DialogContent
        {...sheet.contentProps}
        className="top-0 left-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-dashboard-ink p-0 shadow-none max-h-none sm:top-0 sm:translate-y-0 md:top-1/2 md:left-1/2 md:h-[min(90dvh,960px)] md:w-[min(92vw,1440px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:border"
        onKeyDown={(event) => {
          if (count < 2) return;
          if (event.key === "ArrowLeft") show(index - 1);
          else if (event.key === "ArrowRight") show(index + 1);
          else return;
          event.preventDefault();
        }}
      >
        <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-dashboard-bg-elevated">
          <header className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 border-b border-dashboard-border-strong bg-dashboard-surface-raised px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] md:px-4">
            <div className="min-w-0">
              <DialogTitle className="truncate font-mono text-xs leading-normal font-normal">
                {image.filename}
              </DialogTitle>
              {image.context ? (
                <div className="truncate font-mono text-2xs text-dashboard-text-muted">
                  {image.context}
                </div>
              ) : null}
            </div>
            {count > 1 ? (
              <div className="flex items-center gap-0.5">
                <Button
                  aria-label="Previous image"
                  className={PREVIEW_NAV_BUTTON_CLASS}
                  onClick={() => show(index - 1)}
                >
                  <ChevronLeft aria-hidden="true" size={16} />
                </Button>
                <span className="min-w-12 text-center font-mono text-xs text-dashboard-text-muted tabular-nums">
                  {index + 1} of {count}
                </span>
                <Button
                  aria-label="Next image"
                  className={PREVIEW_NAV_BUTTON_CLASS}
                  onClick={() => show(index + 1)}
                >
                  <ChevronRight aria-hidden="true" size={16} />
                </Button>
              </div>
            ) : (
              <span />
            )}
            <a
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-dashboard-text-muted no-underline transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text"
              href={image.src}
              rel="noreferrer"
              target="_blank"
            >
              <ExternalLink aria-hidden="true" size={14} />
              <span className="max-sm:sr-only">Open raw file</span>
            </a>
            <DialogClose
              render={
                <Button className="h-10 gap-1.5 border-0 bg-transparent px-2.5 text-xs text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text" />
              }
            >
              <X aria-hidden="true" size={16} />
              <span>Close</span>
            </DialogClose>
          </header>
          <div className="grid min-h-0 place-items-center overflow-hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-6">
            <ZoomableImage
              alt={image.filename}
              key={`${image.src}\n${image.filename}`}
              src={image.src}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;

type Zoom = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
type Gesture = {
  /** Untransformed image center. The transform scales around it. */
  center: Point;
  distance: number;
  start: Point;
  zoom: Zoom;
};

const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

/**
 * Let touch readers pinch, drag, and double-tap to zoom one image. The page
 * viewport blocks browser zoom, so the preview owns these gestures.
 */
function ZoomableImage(props: { alt: string; src: string }) {
  const [zoom, setZoom] = useState(NO_ZOOM);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>(undefined);
  const lastTapAt = useRef(0);

  const startGesture = (element: HTMLElement, from: Zoom) => {
    const points = [...pointers.current.values()];
    // The rendered rect still shows the current zoom, even when `from` is a
    // zoom that was just set.
    const rect = element.getBoundingClientRect();
    gesture.current = {
      center: {
        x: rect.left + rect.width / 2 - zoom.x,
        y: rect.top + rect.height / 2 - zoom.y,
      },
      distance: pointDistance(points),
      start: midpoint(points),
      zoom: from,
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (event.pointerType === "mouse") return;
    // Keep move and end events when a finger slides off the image.
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (
      pointers.current.size === 1 &&
      event.timeStamp - lastTapAt.current < DOUBLE_TAP_MS
    ) {
      lastTapAt.current = 0;
      startGesture(event.currentTarget, zoom);
      const next =
        zoom.scale > 1
          ? NO_ZOOM
          : zoomAt(
              gesture.current!,
              point,
              DOUBLE_TAP_ZOOM,
              event.currentTarget,
            );
      setZoom(next);
      startGesture(event.currentTarget, next);
      return;
    }
    if (pointers.current.size === 1) lastTapAt.current = event.timeStamp;
    startGesture(event.currentTarget, zoom);
  };

  const onPointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const start = gesture.current;
    if (!start || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = [...pointers.current.values()];
    const scale =
      points.length > 1 && start.distance > 0
        ? (start.zoom.scale * pointDistance(points)) / start.distance
        : start.zoom.scale;
    setZoom(zoomAt(start, midpoint(points), scale, event.currentTarget));
  };

  const onPointerEnd = (event: PointerEvent<HTMLImageElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const next = zoom.scale < 1.05 ? NO_ZOOM : zoom;
    if (next !== zoom) setZoom(next);
    if (pointers.current.size > 0) startGesture(event.currentTarget, next);
    else gesture.current = undefined;
  };

  return (
    <img
      alt={props.alt}
      className="max-h-full max-w-full touch-none object-contain select-none"
      draggable={false}
      onPointerCancel={onPointerEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      src={props.src}
      style={{
        transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
      }}
    />
  );
}

/**
 * Zoom so the image point under `gesture.start` moves to `point`. This keeps
 * the detail under the reader's fingers while they pinch or drag.
 */
function zoomAt(
  gesture: Gesture,
  point: Point,
  scale: number,
  element: HTMLElement,
): Zoom {
  const next = clamp(scale, 1, MAX_ZOOM);
  const ratio = next / gesture.zoom.scale;
  const x =
    point.x -
    gesture.center.x -
    ratio * (gesture.start.x - gesture.center.x - gesture.zoom.x);
  const y =
    point.y -
    gesture.center.y -
    ratio * (gesture.start.y - gesture.center.y - gesture.zoom.y);
  // Keep the image edges inside the frame.
  const maxX = ((next - 1) * element.offsetWidth) / 2;
  const maxY = ((next - 1) * element.offsetHeight) / 2;
  return {
    scale: next,
    x: clamp(x, -maxX, maxX),
    y: clamp(y, -maxY, maxY),
  };
}

function midpoint(points: readonly Point[]): Point {
  const x = points.reduce((sum, point) => sum + point.x, 0);
  const y = points.reduce((sum, point) => sum + point.y, 0);
  return { x: x / points.length, y: y / points.length };
}

function pointDistance(points: readonly Point[]): number {
  const [first, second] = points;
  if (!first || !second) return 0;
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

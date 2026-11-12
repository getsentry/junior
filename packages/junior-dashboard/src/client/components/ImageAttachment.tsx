import type { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import {
  type MouseEvent,
  type PointerEvent,
  useEffect,
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
  const actions = useRef<DialogPrimitive.Root.Actions>(null);
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
    <Dialog {...sheet.rootProps} actionsRef={actions}>
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
                  variant="outline"
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
                  variant="outline"
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
                <Button
                  variant="outline"
                  className="h-10 gap-1.5 border-0 bg-transparent px-2.5 text-xs text-dashboard-text-muted hover:bg-dashboard-fill-hover hover:text-dashboard-text"
                />
              }
            >
              <X aria-hidden="true" size={16} />
              <span>Close</span>
            </DialogClose>
          </header>
          <ZoomableImage
            alt={image.filename}
            key={`${image.src}\n${image.filename}`}
            onSwipe={(action) => {
              if (action === "dismiss") actions.current?.close();
              else show(index + (action === "next" ? 1 : -1));
            }}
            pageable={count > 1}
            src={image.src}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

const MAX_ZOOM = 4;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
/** Distance before a one-finger drag picks its axis. */
const SWIPE_LOCK_PX = 10;
/** Distance that pages or dismisses on release. Shorter drags spring back. */
const SWIPE_COMMIT_PX = 64;
/** Downward distance that fades the image to its lowest opacity. */
const SWIPE_FADE_PX = 320;

type Zoom = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
type Gesture = {
  /** Untransformed image center. The transform scales around it. */
  center: Point;
  distance: number;
  start: Point;
  zoom: Zoom;
};
/** What a released swipe asks the preview to do. */
type SwipeAction = "dismiss" | "next" | "previous";
/** A one-finger drag on an unzoomed image. `settling` springs it back. */
type Swipe = { axis: "x" | "y"; offset: number; settling?: boolean };

const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

/**
 * Fit one image to the frame and let readers zoom it: pinch, the mouse wheel,
 * or a double tap or double click zooms, and a drag pans. The page viewport blocks
 * browser zoom, so the preview owns these gestures. On an unzoomed image, a
 * sideways touch swipe pages and a downward touch swipe dismisses.
 */
function ZoomableImage(props: {
  alt: string;
  onSwipe(action: SwipeAction): void;
  pageable: boolean;
  src: string;
}) {
  const [zoom, setZoom] = useState(NO_ZOOM);
  const [swipe, setSwipe] = useState<Swipe>();
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>(undefined);
  // "none" holds a touch that no swipe uses, such as an upward drag or a
  // pinch, until every finger lifts.
  const swipeAxis = useRef<"none" | "x" | "y">(undefined);
  const lastTapAt = useRef(0);

  const startGesture = (from: Zoom) => {
    gesture.current = gestureAt(
      [...pointers.current.values()],
      from,
      zoom,
      image.current!,
    );
  };

  // React wheel listeners are passive, so they cannot stop the page or the
  // browser from zooming.
  useEffect(() => {
    const element = frame.current!;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = { x: event.clientX, y: event.clientY };
      // Trackpad pinches arrive as ctrl+wheel with small deltas.
      const speed = event.ctrlKey ? 0.01 : 0.002;
      setZoom(
        zoomAt(
          gestureAt([point], zoom, zoom, image.current!),
          point,
          zoom.scale * Math.exp(-event.deltaY * speed),
          image.current!,
        ),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoom]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const mouse = event.pointerType === "mouse";
    if (mouse && event.button !== 0) return;
    // Keep move and end events when a pointer slides out of the frame.
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    // A mouse drag only pans. Swipes to page or dismiss are for touch.
    swipeAxis.current = mouse || pointers.current.size > 1 ? "none" : undefined;
    if (swipe) setSwipe(undefined);
    if (
      pointers.current.size === 1 &&
      event.timeStamp - lastTapAt.current < DOUBLE_TAP_MS
    ) {
      lastTapAt.current = 0;
      startGesture(zoom);
      const next =
        zoom.scale > 1
          ? NO_ZOOM
          : zoomAt(gesture.current!, point, DOUBLE_TAP_ZOOM, image.current!);
      setZoom(next);
      startGesture(next);
      return;
    }
    if (pointers.current.size === 1) lastTapAt.current = event.timeStamp;
    startGesture(zoom);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (!start || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = [...pointers.current.values()];
    if (
      points.length === 1 &&
      start.zoom.scale === 1 &&
      swipeAxis.current !== "none"
    ) {
      const dx = points[0]!.x - start.start.x;
      const dy = points[0]!.y - start.start.y;
      const axis = swipeAxis.current ?? lockSwipeAxis(dx, dy, props.pageable);
      swipeAxis.current = axis;
      if (axis === "x" || axis === "y") {
        // A swipe is not the first tap of a double tap.
        lastTapAt.current = 0;
        setSwipe({ axis, offset: axis === "x" ? dx : Math.max(dy, 0) });
      }
      return;
    }
    const scale =
      points.length > 1 && start.distance > 0
        ? (start.zoom.scale * pointDistance(points)) / start.distance
        : start.zoom.scale;
    setZoom(zoomAt(start, midpoint(points), scale, image.current!));
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (swipe && !swipe.settling) {
      const action =
        event.type === "pointerup" ? swipeAction(swipe) : undefined;
      if (action) props.onSwipe(action);
      else setSwipe({ ...swipe, offset: 0, settling: true });
    }
    const next = zoom.scale < 1.05 ? NO_ZOOM : zoom;
    if (next !== zoom) setZoom(next);
    if (pointers.current.size > 0) startGesture(next);
    else gesture.current = undefined;
  };

  return (
    // Explicit tracks give the image a definite area, so `max-h-full` fits a
    // tall image to the frame instead of clipping it.
    <div
      className={`grid min-h-0 touch-none grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center overflow-hidden p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-6 ${
        zoom.scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in"
      }`}
      onPointerCancel={onPointerEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      ref={frame}
    >
      <img
        alt={props.alt}
        className={`max-h-full max-w-full object-contain select-none ${
          swipe?.settling
            ? "transition-[opacity,transform] duration-180 ease-out motion-reduce:transition-none"
            : ""
        }`}
        draggable={false}
        onTransitionEnd={() => {
          if (swipe?.settling) setSwipe(undefined);
        }}
        ref={image}
        src={props.src}
        style={
          swipe
            ? {
                opacity:
                  swipe.axis === "y"
                    ? 1 - 0.6 * Math.min(swipe.offset / SWIPE_FADE_PX, 1)
                    : undefined,
                transform:
                  swipe.axis === "x"
                    ? `translateX(${swipe.offset}px)`
                    : `translateY(${swipe.offset}px)`,
              }
            : {
                transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
              }
        }
      />
    </div>
  );
}

/**
 * Start a gesture at `points` from zoom `from`. `rendered` is the zoom the
 * image shows now, which differs from `from` right after a double tap.
 */
function gestureAt(
  points: readonly Point[],
  from: Zoom,
  rendered: Zoom,
  element: HTMLElement,
): Gesture {
  const rect = element.getBoundingClientRect();
  return {
    center: {
      x: rect.left + rect.width / 2 - rendered.x,
      y: rect.top + rect.height / 2 - rendered.y,
    },
    distance: pointDistance(points),
    start: midpoint(points),
    zoom: from,
  };
}

/** Pick the axis of a one-finger drag once it moves far enough. */
function lockSwipeAxis(
  dx: number,
  dy: number,
  pageable: boolean,
): "none" | "x" | "y" | undefined {
  if (Math.hypot(dx, dy) < SWIPE_LOCK_PX) return undefined;
  if (Math.abs(dx) > Math.abs(dy)) return pageable ? "x" : "none";
  return dy > 0 ? "y" : "none";
}

/** Return the action of a released swipe, or nothing when it is too short. */
function swipeAction(swipe: Swipe): SwipeAction | undefined {
  if (Math.abs(swipe.offset) < SWIPE_COMMIT_PX) return undefined;
  if (swipe.axis === "y") return "dismiss";
  // Drag the image left to bring in the next one.
  return swipe.offset < 0 ? "next" : "previous";
}

/**
 * Zoom so the image point under `gesture.start` moves to `point`. This keeps
 * the detail under the reader's fingers while they pinch or drag.
 */
function zoomAt(
  gesture: Gesture,
  point: Point,
  scale: number,
  element: HTMLImageElement,
): Zoom {
  // A tall image that fits the frame may need more than MAX_ZOOM to reach
  // its natural size.
  const max = Math.max(MAX_ZOOM, element.naturalWidth / element.offsetWidth);
  const next = clamp(scale, 1, max);
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

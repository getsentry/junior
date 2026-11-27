import { PreviewCard } from "@base-ui/react/preview-card";
import {
  createContext,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { cn } from "@dashboard/lib/utils";

// A pointer that only passes over a trigger does not open its card.
const PREVIEW_DELAY_MS = 350;

// Base UI reads collision padding in px. 24px matches the 1.5rem side room in
// the popup width.
const COLLISION_PADDING_PX = 24;

// The card goes above or below its trigger, never beside it. A card that
// fits on neither side takes the side with more room and scrolls.
const FLIP_VERTICALLY = { fallbackAxisSide: "none" } as const;
const KEEP_SIDE = { side: "none", fallbackAxisSide: "none" } as const;

type VerticalSide = "top" | "bottom";

const PreviewsOpen = createContext(true);

// A card inside another card would close with it: moving the pointer to the
// inner card leaves the outer one.
const InsidePreview = createContext(false);

/** Tell whether this element sits inside an open hover preview card. */
export function useInsideHoverPreview(): boolean {
  return useContext(InsidePreview);
}

/**
 * Hold the hover previews inside it while `open` is false. A preview that
 * was due shows once it turns true, if the pointer or focus is still on
 * its trigger. A preview that already shows stays.
 */
export function HoverPreviewGate(props: {
  children: ReactNode;
  open: boolean;
}) {
  return <PreviewsOpen value={props.open}>{props.children}</PreviewsOpen>;
}

/**
 * Tell whether a hover card shows. The gate (`allowed`) holds a card back
 * only until it shows: `shown` is this result from the last render. A hand
 * on a mouse is never still, so a gate that closed shown cards would hide
 * one on each move over its trigger or into it.
 */
export function hoverPreviewVisible(state: {
  allowed: boolean;
  open: boolean;
  shown: boolean;
}): boolean {
  return state.open && (state.allowed || state.shown);
}

/**
 * Show a card beside a link or button when the reader hovers or focuses it.
 * `trigger` is the element without children: `children` fill it. With
 * `tapToOpen`, a tap on a touch screen opens the card instead of following
 * the link, a second tap follows it, and the trigger says whether the card
 * is open.
 */
export function HoverPreview(props: {
  children: ReactNode;
  className?: string | undefined;
  content: ReactNode;
  tapToOpen?: boolean | undefined;
  trigger: ReactElement;
}) {
  const allowed = useContext(PreviewsOpen);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const visible = hoverPreviewVisible({ allowed, open, shown });
  if (visible !== shown) setShown(visible);
  // A touch screen has no hover, so the first tap shows the card.
  const [touch, setTouch] = useState(false);
  // When the reader moves into the card, it keeps its side. Opening "More
  // details" grows the card; a flip would move it away from the pointer,
  // and the card would close.
  const [lockedSide, setLockedSide] = useState<VerticalSide>();
  const lockSide = (popup: HTMLElement) => {
    const side = popup.dataset["side"];
    if (side === "top" || side === "bottom") setLockedSide(side);
  };
  return (
    <PreviewCard.Root
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setLockedSide(undefined);
      }}
      open={visible}
    >
      <PreviewCard.Trigger
        delay={PREVIEW_DELAY_MS}
        render={props.trigger}
        {...(props.tapToOpen
          ? {
              "aria-expanded": visible,
              "aria-haspopup": "dialog" as const,
              onClick: (event: MouseEvent) => {
                // With previews gated, a tap follows the link: no card can open.
                if (!touch || !allowed || open) return;
                event.preventDefault();
                setOpen(true);
              },
              onPointerDown: (event: PointerEvent) =>
                setTouch(event.pointerType === "touch"),
            }
          : undefined)}
      >
        {props.children}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          className="isolate z-50"
          collisionAvoidance={lockedSide ? KEEP_SIDE : FLIP_VERTICALLY}
          collisionPadding={COLLISION_PADDING_PX}
          side={lockedSide}
          sideOffset={6}
        >
          <PreviewCard.Popup
            className={cn(
              "max-h-(--available-height) w-[30rem] max-w-[calc(100vw-3rem)] overflow-y-auto overscroll-contain rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel shadow-2xl shadow-black/40 outline-none",
              props.className,
            )}
            onFocus={(event) => lockSide(event.currentTarget)}
            onPointerEnter={(event) => lockSide(event.currentTarget)}
          >
            <InsidePreview value>{props.content}</InsidePreview>
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

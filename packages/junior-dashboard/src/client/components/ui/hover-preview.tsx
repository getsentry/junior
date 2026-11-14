import { PreviewCard } from "@base-ui/react/preview-card";
import { useState, type ReactElement, type ReactNode } from "react";
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

/**
 * Show a card beside a link or button when the reader hovers or focuses it.
 * `trigger` is the element without children: `children` fill it.
 */
export function HoverPreview(props: {
  children: ReactNode;
  className?: string;
  content: ReactNode;
  trigger: ReactElement;
}) {
  // When the reader moves into the card, it keeps its side. Opening "More
  // details" grows the card; a flip would move it away from the pointer,
  // and the card would close.
  const [lockedSide, setLockedSide] = useState<VerticalSide>();
  const lockSide = (popup: HTMLElement) => {
    const side = popup.dataset.side;
    if (side === "top" || side === "bottom") setLockedSide(side);
  };
  return (
    <PreviewCard.Root
      onOpenChange={(open) => {
        if (!open) setLockedSide(undefined);
      }}
    >
      <PreviewCard.Trigger delay={PREVIEW_DELAY_MS} render={props.trigger}>
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
            {props.content}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

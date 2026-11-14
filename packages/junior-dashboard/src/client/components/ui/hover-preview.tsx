import { PreviewCard } from "@base-ui/react/preview-card";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@dashboard/lib/utils";

// A pointer that only passes over a trigger does not open its card.
const PREVIEW_DELAY_MS = 350;

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
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger delay={PREVIEW_DELAY_MS} render={props.trigger}>
        {props.children}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          className="isolate z-50"
          collisionPadding={8}
          sideOffset={6}
        >
          <PreviewCard.Popup
            className={cn(
              "w-[30rem] max-w-[calc(100vw-1rem)] rounded-xl shadow-2xl shadow-black/40 outline-none",
              props.className,
            )}
          >
            {props.content}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

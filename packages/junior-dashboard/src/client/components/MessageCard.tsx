import type { ComponentProps, ReactNode } from "react";

import { cn } from "@dashboard/lib/utils";
import { Item, ItemContent, ItemMedia } from "./ui/item";

/**
 * Frame one card in the transcript. Object, automation, and Review item
 * cards share this frame, so they read as one family. The card fills its
 * column.
 */
export function MessageCard({
  className,
  ...props
}: ComponentProps<"section">) {
  return (
    <section
      {...props}
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-xl border border-dashboard-border-emphasis bg-dashboard-surface-panel font-sans text-sm text-dashboard-text",
        className,
      )}
    />
  );
}

/** Head a card with a framed icon, a muted line, and the title. */
export function MessageCardHeader(props: {
  className?: string | undefined;
  icon: ReactNode;
  meta: ReactNode;
  title: ReactNode;
}) {
  return (
    <Item className={cn("items-start", props.className)} size="card">
      <ItemMedia className="text-dashboard-text-muted" variant="icon">
        {props.icon}
      </ItemMedia>
      <ItemContent className="block">
        <p className="m-0 mb-1 break-words text-xs text-dashboard-text-muted">
          {props.meta}
        </p>
        {props.title}
      </ItemContent>
    </Item>
  );
}

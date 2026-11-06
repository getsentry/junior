import type { ComponentProps, ReactNode } from "react";
import { cn } from "@dashboard/lib/utils";
import { Button } from "./button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

// Ported from the AI Elements `Message` primitives
// (https://ui.shadcn.com/docs/ai-elements/base/message) onto dashboard
// buttons and tooltips. Role-specific layout, such as avatars, stays with the
// caller.

/** Group one chat message so its content and actions share hover and focus state. */
function Message({ className, ...props }: ComponentProps<"article">) {
  return (
    <article
      data-slot="message"
      className={cn("group/message grid min-w-0", className)}
      {...props}
    />
  );
}

/** Hold the body of one message: text, attachments, cards, and actions. */
function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2", className)}
      {...props}
    />
  );
}

/**
 * Lay out the actions for one message. Fine pointers show them on message
 * hover or focus, or while one of them has a menu open. Touch screens always
 * show them.
 */
function MessageActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-actions"
      className={cn(
        "flex items-center gap-0.5 [@media(hover:hover)_and_(pointer:fine)_and_(not_(any-pointer:coarse))]:opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100 has-[[aria-expanded=true]]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** Render one icon action. The label names the button and fills its tooltip. */
function MessageAction({
  children,
  label,
  ...props
}: Omit<ComponentProps<typeof Button>, "aria-label" | "children" | "size"> & {
  children: ReactNode;
  label: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-slot="message-action"
            aria-label={label}
            size="icon"
            {...props}
          >
            {children}
          </Button>
        }
      />
      <TooltipContent size="compact">{label}</TooltipContent>
    </Tooltip>
  );
}

export { Message, MessageAction, MessageActions, MessageContent };

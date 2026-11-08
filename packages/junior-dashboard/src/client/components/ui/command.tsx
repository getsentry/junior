import type { ComponentProps, ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@dashboard/lib/utils";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@dashboard/components/ui/dialog";

/** Own keyboard selection for a searchable list of commands. */
function Command({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full min-h-0 flex-col overflow-hidden text-dashboard-text",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Show a `Command` in a dialog near the top of the page. Small screens let the
 * list fill the dialog, so every row fits without a hidden scroll.
 */
function CommandDialog({
  children,
  className,
  title,
  ...props
}: Omit<ComponentProps<typeof Dialog>, "children"> & {
  children: ReactNode;
  className?: string;
  /** Accessible dialog name. It is not shown. */
  title: string;
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn(
          "flex max-w-xl flex-col gap-0 overflow-hidden p-0 sm:top-[15vh] sm:translate-y-0",
          className,
        )}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Search field for a `Command`. Extra content, such as a key hint, goes at the end. */
function CommandInput({
  children,
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center gap-3 border-b border-dashboard-border-subtle px-4"
    >
      <Search
        aria-hidden="true"
        className="size-4 shrink-0 text-dashboard-text-muted"
      />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-12 min-w-0 flex-1 border-0 bg-transparent font-sans text-sm text-dashboard-text outline-none placeholder:text-dashboard-text-faint",
          className,
        )}
        {...props}
      />
      {children}
    </div>
  );
}

/** Scroll the `Command` results. */
function CommandList({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "thin-scrollbar min-h-0 scroll-py-2 overflow-y-auto overscroll-contain p-2 sm:max-h-[min(24rem,60dvh)]",
        className,
      )}
      {...props}
    />
  );
}

/** Show when the `Command` has no results. */
function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(
        "px-3 py-6 text-center font-sans text-sm text-dashboard-text-muted",
        className,
      )}
      {...props}
    />
  );
}

/** Group `Command` results under a heading. */
function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "**:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:font-sans **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-dashboard-text-muted",
        className,
      )}
      {...props}
    />
  );
}

/** One selectable `Command` result. Its icons stay muted. */
function CommandItem({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 font-sans text-sm text-dashboard-text outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-dashboard-fill-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-dashboard-text-muted",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
};

import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

import { Button } from "@dashboard/components/ui/button";
import { Input } from "@dashboard/components/ui/input";

/** Frame one text input with its icons and inline buttons. */
function InputGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex h-9 w-full min-w-0 items-center rounded-md border border-dashboard-border bg-dashboard-overlay-soft transition-colors outline-none hover:border-dashboard-border-emphasis has-[[data-slot=input-group-control]:focus-visible]:border-dashboard-focus has-[[data-slot=input-group-control]:focus-visible]:ring-1 has-[[data-slot=input-group-control]:focus-visible]:ring-dashboard-focus/25",
        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-2 py-1.5 text-sm font-medium text-dashboard-text-muted select-none",
  {
    variants: {
      align: {
        "inline-start": "order-first pl-2.5",
        "inline-end": "order-last pr-1.5",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

/** Place an icon or button before or after the input. A click on the addon focuses the input. */
function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

/** Render a compact icon button inside an input group. */
function InputGroupButton({
  className,
  type = "button",
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "type"> & {
  type?: "button" | "submit" | "reset";
}) {
  return (
    <Button
      type={type}
      size="icon"
      className={cn("size-6", className)}
      {...props}
    />
  );
}

/** Render the text input inside an input group. */
function InputGroupInput({
  className,
  ...props
}: ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-2 focus:ring-0",
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput };

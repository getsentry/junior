import type { ComponentProps } from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

const itemVariants = cva(
  // A linked or clickable item lights up on hover; a plain one does not.
  "group/item w-full min-w-0 text-left text-inherit no-underline [&:is(a,button)]:transition-colors [&:is(a,button)]:hover:bg-accent [&:is(a,button)]:focus-visible:outline-2 [&:is(a,button)]:focus-visible:-outline-offset-2 [&:is(a,button)]:focus-visible:outline-ring",
  {
    variants: {
      size: {
        /**
         * One compact row of a list, such as a details panel row. A grid, so
         * a long title truncates instead of widening the list.
         */
        default:
          "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 rounded-md px-1.5 py-1.5",
        /** The head of a card: a framed icon beside the title. */
        card: "flex gap-3 px-4 pt-4 pb-3 md:px-5",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

/** Lay out one object: media, then its content. */
function Item({
  className,
  render,
  size = "default",
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ size }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "item",
      size,
    },
  });
}

const itemMediaVariants = cva("grid shrink-0 place-items-center", {
  variants: {
    variant: {
      /** A small icon beside a row title. */
      default: "size-5 text-muted-foreground",
      /** A framed icon at the head of a card. */
      icon: "size-9 rounded-lg border border-border bg-dashboard-fill-soft",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

/** Hold the icon of an item. */
function ItemMedia({
  className,
  variant = "default",
  ...props
}: ComponentProps<"span"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <span
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant }), className)}
      {...props}
    />
  );
}

/** Stack the title and the lines under it. */
function ItemContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="item-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}
      {...props}
    />
  );
}

export { Item, ItemContent, ItemMedia };

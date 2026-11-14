import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

// Display stays with the caller: a badge that truncates or wraps its own
// text must stay a block or inline box, because a flex box drops the
// ellipsis.
const badgeVariants = cva("px-1.5 font-sans", {
  variants: {
    variant: {
      /** A count beside a navigation label. */
      highlight: "rounded-full bg-violet-300/20 text-xs text-violet-200",
      /** A count or group of icons on a list row. */
      count:
        "rounded-full border border-dashboard-border-strong bg-dashboard-control text-2xs leading-none text-muted-foreground tabular-nums",
      /** A tag or a type name. A linked tag lights up on hover. */
      outline:
        "rounded-md border border-border text-2xs text-muted-foreground [a]:no-underline [a]:transition-colors [a]:hover:border-dashboard-border-strong [a]:hover:bg-dashboard-fill-soft [a]:hover:text-foreground [a]:focus-visible:outline-2 [a]:focus-visible:outline-offset-1 [a]:focus-visible:outline-ring",
      /** A filled chip, such as one event type. */
      secondary:
        "rounded-md bg-dashboard-fill-soft text-xs leading-4 text-dashboard-text-subtle",
      /** A filter that narrows the chips beside it. */
      dashed:
        "rounded-md border border-dashed border-border text-xs leading-4 text-muted-foreground",
      /** A count in a tab. */
      muted:
        "rounded-sm border border-border bg-dashboard-fill-soft text-xs text-muted-foreground",
      /** A selected or featured mark. */
      accent:
        "rounded-sm border border-dashboard-accent/25 bg-dashboard-accent/10 text-xs text-dashboard-accent-text",
      /** A mark that warns about a problem. */
      destructive:
        "rounded-sm border border-destructive/40 text-xs text-destructive",
    },
  },
});

/** Show a short label, count, or tag. */
function Badge({
  className,
  render,
  variant,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge };

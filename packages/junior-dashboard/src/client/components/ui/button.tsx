import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

const commandButtonClass =
  "inline-flex h-9 max-w-full items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium leading-none focus-visible:outline-2 focus-visible:outline-offset-2";

/**
 * Style the dashboard button surfaces with the shadcn variant and size
 * names. Variants set colors; sizes set the box. Links use it with
 * `className`.
 */
const buttonVariants = cva(
  "cursor-pointer font-sans no-underline transition-colors data-disabled:cursor-not-allowed data-disabled:opacity-50",
  {
    variants: {
      variant: {
        /** The primary action of a view. */
        default:
          "border-primary bg-primary text-primary-foreground hover:border-dashboard-text-subtle hover:bg-dashboard-text-subtle focus-visible:outline-ring data-disabled:hover:border-primary data-disabled:hover:bg-primary",
        /** A command beside or instead of the primary action. */
        outline:
          "border-input bg-secondary text-foreground hover:border-dashboard-border-heavy hover:bg-accent hover:text-foreground focus-visible:outline-ring data-disabled:hover:border-input data-disabled:hover:bg-secondary data-disabled:hover:text-foreground",
        /** A low-emphasis action, such as Dismiss, an icon, or a list row. */
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-dashboard-fill-strong hover:text-foreground focus-visible:outline-ring data-disabled:hover:bg-transparent data-disabled:hover:text-muted-foreground",
        /** An action that deletes or revokes. */
        destructive:
          "border-dashboard-border-strong bg-transparent text-muted-foreground hover:border-rose-300/40 hover:text-rose-300 focus-visible:outline-rose-300/55 data-disabled:hover:border-dashboard-border-strong data-disabled:hover:text-muted-foreground",
        /** An action that reads as a link in running text. It has no box. */
        link: "border-0 bg-transparent p-0 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      },
      size: {
        default: "",
        /** No box. The caller lays out the button, such as a list row. */
        bare: "focus-visible:outline-2",
        icon: "grid size-9 place-items-center rounded-md border-0 p-0 focus-visible:outline-2 focus-visible:outline-offset-1",
        // Body weight keeps menu rows below headings; icons stay muted until the row is active.
        menu: "flex w-full items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-sm font-normal text-foreground hover:bg-dashboard-fill-strong focus-visible:bg-dashboard-fill-strong focus-visible:outline-none data-disabled:hover:bg-transparent [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground focus-visible:[&_svg]:text-foreground data-disabled:hover:[&_svg]:text-muted-foreground",
      },
    },
    compoundVariants: [
      {
        size: "default",
        variant: ["default", "outline", "ghost", "destructive"],
        className: commandButtonClass,
      },
      {
        size: "icon",
        variant: "destructive",
        className: "hover:bg-rose-300/10 data-disabled:hover:bg-transparent",
      },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/** Render a Base UI button with a dashboard button surface. */
function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: Omit<ButtonPrimitive.Props, "className"> &
  VariantProps<typeof buttonVariants> & { className?: string | undefined }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };

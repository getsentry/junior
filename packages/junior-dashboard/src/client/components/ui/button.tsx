// Adapted from shadcn/ui Base UI Button. See shadcn.LICENSE.
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@dashboard/lib/utils";

const commandButtonClass =
  "inline-flex h-9 max-w-full items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium leading-none focus-visible:outline-2 focus-visible:outline-offset-2";

/** Style the dashboard command, primary, danger, and icon button surfaces. Links use it with `className`. */
const buttonVariants = cva(
  "cursor-pointer font-sans no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "",
        primary: "",
        danger: "",
      },
      size: {
        default: "",
        icon: "grid size-9 place-items-center rounded-md border-0 bg-transparent p-0 text-dashboard-text-muted focus-visible:outline-2 focus-visible:outline-offset-1 disabled:hover:!bg-transparent disabled:hover:!text-dashboard-text-muted",
      },
    },
    compoundVariants: [
      {
        size: "default",
        variant: "default",
        className: cn(
          commandButtonClass,
          "border-dashboard-border-emphasis bg-dashboard-surface-raised text-dashboard-text hover:border-dashboard-border-heavy hover:bg-dashboard-surface-hover hover:text-dashboard-text focus-visible:outline-dashboard-focus disabled:hover:border-dashboard-border-emphasis disabled:hover:bg-dashboard-surface-raised disabled:hover:text-dashboard-text",
        ),
      },
      {
        size: "default",
        variant: "primary",
        className: cn(
          commandButtonClass,
          "border-dashboard-text-solid bg-dashboard-text-solid text-dashboard-text-inverse hover:border-dashboard-text-subtle hover:bg-dashboard-text-subtle focus-visible:outline-dashboard-focus disabled:hover:border-dashboard-text-solid disabled:hover:bg-dashboard-text-solid",
        ),
      },
      {
        size: "default",
        variant: "danger",
        className: cn(
          commandButtonClass,
          "border-dashboard-border-strong bg-transparent text-dashboard-text-muted hover:border-rose-300/40 hover:text-rose-300 focus-visible:outline-rose-300/55 disabled:hover:border-dashboard-border-strong disabled:hover:text-dashboard-text-muted",
        ),
      },
      {
        size: "icon",
        variant: ["default", "primary"],
        className:
          "hover:!bg-dashboard-fill-strong hover:!text-dashboard-text focus-visible:outline-dashboard-focus",
      },
      {
        size: "icon",
        variant: "danger",
        className:
          "hover:!bg-rose-300/10 hover:!text-rose-300 focus-visible:outline-rose-300/55",
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
  VariantProps<typeof buttonVariants> & { className?: string }) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };

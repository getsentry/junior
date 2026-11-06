import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { cn } from "@dashboard/lib/utils";

/** Render a round avatar frame. Use `size="sm"` in dense lists. */
function Avatar({
  className,
  size = "default",
  ...props
}: AvatarPrimitive.Root.Props & {
  size?: "default" | "sm";
}) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative inline-grid size-7 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-dashboard-bg bg-dashboard-focus shadow-sm select-none data-[size=sm]:size-6",
        className,
      )}
      {...props}
    />
  );
}

/** Show the avatar image after it loads. */
function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("size-full object-cover", className)}
      {...props}
    />
  );
}

/** Show initials or a count while the image is missing, loading, or broken. */
function AvatarFallback({
  className,
  ...props
}: AvatarPrimitive.Fallback.Props) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "grid size-full place-items-center font-sans text-xs leading-none font-semibold tracking-tight text-dashboard-text-inverse group-data-[size=sm]/avatar:text-2xs",
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };

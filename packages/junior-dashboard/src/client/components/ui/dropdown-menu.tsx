import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@dashboard/lib/utils";
import { useMobileLayout } from "@dashboard/layoutMedia";

import {
  PHONE_MENU_CANCEL_CLASS,
  PHONE_MENU_GROUP_CLASS,
  PHONE_MENU_ITEM_CLASS,
  PHONE_SHEET_BACKDROP_CLASS,
  PHONE_SHEET_POPUP_CLASS,
  PHONE_SHEET_POSITIONER_CLASS,
} from "./phoneSheet";

/** Own a dropdown menu's open state. */
function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

/** Open the menu from the owning control. */
function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

/**
 * Place menu items beside the trigger on the popover surface. A phone shows
 * them as an action sheet on the bottom edge, with a Cancel row.
 */
function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  const mobile = useMobileLayout();
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Backdrop className={PHONE_SHEET_BACKDROP_CLASS} />
      <MenuPrimitive.Positioner
        className={cn(
          "isolate z-50 outline-none",
          PHONE_SHEET_POSITIONER_CLASS,
        )}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "z-50 max-h-(--available-height) w-(--anchor-width) min-w-32 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
            PHONE_SHEET_POPUP_CLASS,
          )}
          {...props}
        >
          {mobile ? (
            <>
              <div className={PHONE_MENU_GROUP_CLASS}>{children}</div>
              <MenuPrimitive.Item className={PHONE_MENU_CANCEL_CLASS}>
                Cancel
              </MenuPrimitive.Item>
            </>
          ) : (
            children
          )}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

// Same row as `ui/context-menu`, so the `⋯` menu and the sidebar row menu,
// which show the same rows, look the same.
const DROPDOWN_MENU_ITEM_CLASS =
  "group/dropdown-menu-item relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:[&_svg]:text-destructive";

/** Run one menu action. */
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(DROPDOWN_MENU_ITEM_CLASS, PHONE_MENU_ITEM_CLASS, className)}
      {...props}
    />
  );
}

/**
 * Open one link from the menu. Pass `render={<Link />}` for app routes. The
 * menu closes on click, like other items; Base UI keeps it open by default.
 */
function DropdownMenuLinkItem({
  className,
  closeOnClick = true,
  ...props
}: MenuPrimitive.LinkItem.Props) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="dropdown-menu-item"
      className={cn(DROPDOWN_MENU_ITEM_CLASS, PHONE_MENU_ITEM_CLASS, className)}
      closeOnClick={closeOnClick}
      {...props}
    />
  );
}

/** Own the one checked value of a set of radio items. */
function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

/**
 * Pick one value of a radio group. The caller gives the look, such as an
 * icon segment. The menu stays open on click, so the choice shows at once.
 */
function DropdownMenuRadioItem({ ...props }: MenuPrimitive.RadioItem.Props) {
  return (
    <MenuPrimitive.RadioItem data-slot="dropdown-menu-radio-item" {...props} />
  );
}

/** Divide groups of menu items. */
function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
};

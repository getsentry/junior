import {
  ChevronsUpDown,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { peoplePath } from "../format";
import { cn, dashboardInteractiveTextClass } from "../styles";
import type { Identity } from "../types";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";
import { navItemIcon } from "./layout/navIcons";
import { NavLayoutSwitcher } from "./NavLayoutSwitcher";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem } from "./ui/sidebar";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
  /** Pages that live in this menu instead of the primary nav. */
  pages: DashboardHeaderNavItem[];
  /**
   * `popover` is the profile row at the bottom of the desktop nav sidebar.
   * It shows only the avatar while the sidebar is collapsed.
   * `top-bar` is the avatar control in the desktop top bar.
   * `sheet-links` is plain account destinations for the mobile nav sheet.
   * `sheet-identity` is the quiet signed-in strip at the bottom of that sheet.
   */
  variant?: "popover" | "top-bar" | "sheet-links" | "sheet-identity";
};

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 140;

function initials(name: string | null | undefined, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    return words
      .slice(0, 2)
      .map((word) => word[0])
      .join("")
      .toUpperCase();
  }
  return email.slice(0, 1).toUpperCase();
}

/** Show the viewer's photo, with initials while it loads or when there is none. */
function ProfileAvatar({
  className,
  user,
}: {
  className?: string;
  user: Identity["user"];
}) {
  return (
    <Avatar
      aria-hidden="true"
      className={cn("border-0 shadow-black/40", className)}
    >
      <AvatarImage alt="User avatar" src={user.avatarUrl} />
      <AvatarFallback className="font-bold tracking-wide">
        {initials(user.name, user.email!)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Group the signed-in identity, personal profile, and session actions. */
export function ProfileMenu({
  identity,
  onSignOut,
  pages,
  variant = "popover",
}: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const email = identity.user.email!;
  const name = identity.user.name?.trim() || email;

  // Plain content, not a group label: it names no menu items.
  const identityBlock = (
    <div className="px-2 py-1.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <ProfileAvatar className="size-8" user={identity.user} />
        <div className="min-w-0">
          <p className="m-0 truncate text-sm font-semibold text-dashboard-text">
            {name}
          </p>
          {name !== email ? (
            <p className="mt-0.5 mb-0 truncate text-xs text-dashboard-text-muted">
              {email}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );

  const menuLinks = (
    <>
      <DropdownMenuLinkItem render={<Link to={peoplePath(email)} />}>
        <UserRound aria-hidden="true" />
        My profile
      </DropdownMenuLinkItem>
      <DropdownMenuLinkItem render={<Link to="/settings" />}>
        <Settings aria-hidden="true" />
        Settings
      </DropdownMenuLinkItem>
      {pages.map((page) => {
        const Icon = navItemIcon(page.key);
        return (
          <DropdownMenuLinkItem key={page.key} render={<Link to={page.to} />}>
            <Icon aria-hidden="true" />
            {page.label}
          </DropdownMenuLinkItem>
        );
      })}
      {identity.user.isAdmin ? (
        <DropdownMenuLinkItem render={<Link to="/admin" />}>
          <ShieldCheck aria-hidden="true" />
          Admin
        </DropdownMenuLinkItem>
      ) : null}
      <DropdownMenuItem onClick={() => void onSignOut()}>
        <LogOut aria-hidden="true" />
        Log out
      </DropdownMenuItem>
    </>
  );

  if (variant === "sheet-links") {
    // Match primary sheet rows exactly.
    const sheetItemClass = cn(
      "rounded-lg border-0 bg-transparent px-3 py-3 text-left font-sans text-sm font-medium no-underline transition-colors hover:bg-dashboard-fill-soft focus-visible:bg-dashboard-fill-soft focus-visible:outline-none",
      dashboardInteractiveTextClass,
    );
    return (
      <nav aria-label={`Account menu for ${name}`} className="grid gap-1">
        <Link className={sheetItemClass} to={peoplePath(email)}>
          My profile
        </Link>
        <Link className={sheetItemClass} to="/settings">
          Settings
        </Link>
        {pages.map((page) => (
          <Link className={sheetItemClass} key={page.key} to={page.to}>
            {page.label}
          </Link>
        ))}
        {identity.user.isAdmin ? (
          <Link className={sheetItemClass} to="/admin">
            Admin
          </Link>
        ) : null}
        <button
          className={cn(sheetItemClass, "w-full cursor-pointer")}
          data-mobile-nav-dismiss
          onClick={() => {
            void onSignOut();
          }}
          type="button"
        >
          Log out
        </button>
        <ThemeSwitcher className="px-3 py-2" />
      </nav>
    );
  }

  if (variant === "sheet-identity") {
    return (
      <div
        aria-label={`Signed in as ${name}`}
        className="flex min-w-0 items-center gap-2.5 px-1"
      >
        <ProfileAvatar user={identity.user} />
        <div className="min-w-0">
          <p className="m-0 truncate text-xs font-semibold text-dashboard-text">
            {name}
          </p>
          {name !== email ? (
            <p className="mt-0.5 mb-0 truncate font-sans text-xs text-dashboard-text-muted">
              {email}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const topBar = variant === "top-bar";
  const menuLabel = `${open ? "Close" : "Open"} profile menu for ${name}`;
  const hoverTrigger = {
    closeDelay: HOVER_CLOSE_DELAY_MS,
    delay: HOVER_OPEN_DELAY_MS,
    openOnHover: true,
  };
  return (
    // Not modal, so the page keeps scrolling while the menu is open.
    <DropdownMenu
      modal={false}
      onOpenChange={(nextOpen, details) => {
        // A mouse click always keeps the menu open, also after hover opened it.
        // A keyboard press (detail 0) still toggles it.
        const mouseClick =
          details.event instanceof MouseEvent && details.event.detail > 0;
        if (!nextOpen && details.reason === "trigger-press" && mouseClick) {
          return;
        }
        setOpen(nextOpen);
      }}
      open={open}
    >
      {topBar ? (
        <DropdownMenuTrigger
          aria-label={menuLabel}
          className={cn(
            "grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent transition-colors hover:bg-dashboard-fill-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70",
            open && "bg-dashboard-fill-hover",
          )}
          {...hoverTrigger}
        >
          <ProfileAvatar user={identity.user} />
        </DropdownMenuTrigger>
      ) : (
        <SidebarMenuItem>
          <SidebarMenuButton
            aria-label={menuLabel}
            className={cn(
              // The collapsed nav sidebar shows only the avatar.
              "h-10 gap-2.5 rounded-lg px-1.5 group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0! [&_svg]:size-3.5",
              open && "bg-sidebar-accent",
            )}
            render={<DropdownMenuTrigger {...hoverTrigger} />}
          >
            <ProfileAvatar user={identity.user} />
            <span className="min-w-0 flex-1 truncate font-medium group-data-[collapsible=icon]:hidden">
              {name}
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              className="text-dashboard-text-muted group-data-[collapsible=icon]:hidden"
              strokeWidth={2}
            />
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
      <DropdownMenuContent
        align="end"
        side={topBar ? "bottom" : "right"}
        sideOffset={8}
        className="w-64"
        id="profile-popover"
      >
        {identityBlock}
        <DropdownMenuSeparator />
        <div className="grid gap-1 px-2 py-1.5">
          <ThemeSwitcher menu />
          <NavLayoutSwitcher menu />
        </div>
        <DropdownMenuSeparator />
        {menuLinks}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

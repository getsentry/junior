import {
  Boxes,
  ChevronsUpDown,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { PluginUserPageLink } from "@sentry/junior-plugin-api";

import { peoplePath } from "../format";
import { pluginUserPagePath } from "../pages/user/pluginUserPageRoutes";
import { cn, dashboardInteractiveTextClass } from "../styles";
import type { Identity } from "../types";
import { ThemeSwitcher } from "./ThemeSwitcher";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button, buttonVariants } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type ProfileMenuProps = {
  identity: Identity;
  onSignOut(): Promise<void>;
  userPages: PluginUserPageLink[];
  /**
   * `popover` is the profile row at the bottom of the desktop nav sidebar.
   * It shows only the avatar while the sidebar is collapsed.
   * `sheet-links` is plain account destinations for the mobile nav sheet.
   * `sheet-identity` is the quiet signed-in strip at the bottom of that sheet.
   */
  variant?: "popover" | "sheet-links" | "sheet-identity";
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

const profileLinkClass = buttonVariants({ size: "menu" });

/** Group the signed-in identity, personal profile, and session actions. */
export function ProfileMenu({
  identity,
  onSignOut,
  userPages,
  variant = "popover",
}: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const email = identity.user.email!;
  const name = identity.user.name?.trim() || email;
  const profilePages = userPages.filter(
    (page) => page.navigation === "profile",
  );

  const identityBlock = (
    <div className="border-b border-dashboard-border-strong px-2.5 py-2.5">
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

  const menuLinks = (close: () => void) => (
    <>
      <Link
        className={cn(profileLinkClass, "mt-1")}
        onClick={close}
        to={peoplePath(email)}
      >
        <UserRound aria-hidden="true" size={16} strokeWidth={2} />
        My profile
      </Link>
      <Link className={profileLinkClass} onClick={close} to="/settings">
        <Settings aria-hidden="true" size={16} strokeWidth={2} />
        Settings
      </Link>
      {identity.user.isAdmin ? (
        <Link className={profileLinkClass} onClick={close} to="/admin">
          <ShieldCheck aria-hidden="true" size={16} strokeWidth={2} />
          Admin
        </Link>
      ) : null}
      {profilePages.map((page) => (
        <Link
          className={profileLinkClass}
          key={`${page.pluginName}:${page.id}`}
          onClick={close}
          to={pluginUserPagePath(page.pluginName, page.id)}
        >
          <Boxes aria-hidden="true" size={16} strokeWidth={2} />
          {page.label}
        </Link>
      ))}
      <Button
        onClick={() => {
          close();
          void onSignOut();
        }}
        size="menu"
      >
        <LogOut aria-hidden="true" size={16} strokeWidth={2} />
        Log out
      </Button>
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
        {identity.user.isAdmin ? (
          <Link className={sheetItemClass} to="/admin">
            Admin
          </Link>
        ) : null}
        {profilePages.map((page) => (
          <Link
            className={sheetItemClass}
            key={`${page.pluginName}:${page.id}`}
            to={pluginUserPagePath(page.pluginName, page.id)}
          >
            {page.label}
          </Link>
        ))}
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

  const menuLabel = `${open ? "Close" : "Open"} profile menu for ${name}`;
  return (
    <Popover
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
      <PopoverTrigger
        aria-label={menuLabel}
        className={cn(
          // The collapsed nav sidebar shows only the avatar.
          "group/profile flex h-10 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-1.5 text-left text-dashboard-text transition-colors hover:bg-dashboard-fill-hover hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-dashboard-focus/70 group-data-[collapsible=icon]:size-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
          open && "bg-dashboard-fill-hover text-dashboard-text",
        )}
        closeDelay={HOVER_CLOSE_DELAY_MS}
        delay={HOVER_OPEN_DELAY_MS}
        openOnHover
      >
        <ProfileAvatar user={identity.user} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium group-data-[collapsible=icon]:hidden">
          {name}
        </span>
        <ChevronsUpDown
          aria-hidden="true"
          className="shrink-0 text-dashboard-text-muted transition-colors group-hover/profile:text-dashboard-text group-data-[collapsible=icon]:hidden"
          size={14}
          strokeWidth={2}
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="right"
        className="w-64 rounded-xl border-0 bg-dashboard-surface-raised/95 p-1.5 shadow-2xl shadow-black/75 backdrop-blur-xl"
        id="profile-popover"
      >
        {identityBlock}
        <ThemeSwitcher className="border-b border-dashboard-border-strong px-2.5 py-2" />
        {menuLinks(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

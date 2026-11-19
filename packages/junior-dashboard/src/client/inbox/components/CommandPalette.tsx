import type { LucideIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import { isPlatformShortcut, platformShortcut } from "../../keyboard";
import { paneDestinationForPath } from "../../components/layout/paneRows";
import { directoryGroupForPath } from "../../components/paletteDirectories";
import type { DashboardHeaderNavItem } from "./layout/DashboardHeader";

// The palette opens only after a shortcut or a click, so cmdk loads with
// the first open instead of with the page.
const CommandPaletteDialog = lazy(() =>
  import("./CommandPaletteDialog").then((module) => ({
    default: module.CommandPaletteDialog,
  })),
);

/** Shortcut text for command palette triggers on this platform. */
export const COMMAND_PALETTE_SHORTCUT = platformShortcut("k");

/** Name of the command palette and the controls that open it. */
export const COMMAND_PALETTE_LABEL = "Go to conversation";

// The Inbox lists Conversations, so they rank first there.
const DESTINATION_GROUPS: Record<"automations" | "inbox", string> = {
  automations: "Automations",
  inbox: "Conversations",
};

/**
 * The palette group of the page that shows, which ranks first: a
 * directory such as People or Runs, the event log's Events, or the
 * destination's group.
 */
export function paletteGroupForPath(
  pathname: string,
  eventLogShown: boolean,
): string | undefined {
  if (eventLogShown) return "Events";
  const destination = paneDestinationForPath(pathname);
  return (
    directoryGroupForPath(pathname) ??
    (destination && DESTINATION_GROUPS[destination])
  );
}

/** A command that acts on the page, such as Zen mode, rather than going somewhere. */
export type PaletteAction = {
  icon: LucideIcon;
  id: string;
  label: string;
  /** Shortcut text, such as `⌥⌘Y`. */
  shortcut?: string;
  run(): void;
};

/** What the shell gives the command palette. */
export type CommandPaletteProps = {
  actions?: PaletteAction[];
  /** The group of the page that shows, from `paletteGroupForPath`. */
  activeGroup?: string;
  /** Left out of the rows: the viewer is already there. */
  currentConversationId?: string | undefined;
  navItems: DashboardHeaderNavItem[];
  open: boolean;
  onOpenChange(open: boolean): void;
};

/**
 * Switch conversations and jump to dashboard pages from anywhere, like an
 * editor's quick open. Owns the global ⌘K / Ctrl+K shortcut; triggers in the
 * shell call `onOpenChange`.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const { onOpenChange, open } = props;
  // After the first open the dialog stays mounted, so it can animate closed.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  useEffect(() => {
    const toggle = (event: globalThis.KeyboardEvent) => {
      if (!isPlatformShortcut(event, "k") || event.repeat) return;
      event.preventDefault();
      onOpenChange(!open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, [onOpenChange, open]);

  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <CommandPaletteDialog {...props} />
    </Suspense>
  );
}

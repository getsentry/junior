import { useEffect } from "react";
import { NavigationType, useNavigationType, type Location } from "react-router";
import * as z from "zod";

import {
  isConversationOrigin,
  type ConversationOrigin,
  type PaneRow,
} from "../components/layout/paneRows";
import { isSpacePath } from "../spaces/spaceRoutes";

/**
 * What opened a Conversation: a list of the pane, or the path of a Space
 * page.
 */
export type ConversationOpener = ConversationOrigin | (string & {});

/** True for a value that can be the opener of a Conversation. */
function isConversationOpener(
  value: string | undefined,
): value is ConversationOpener {
  return isConversationOrigin(value) || (!!value && isSpacePath(value));
}

// Origins by history entry key, as React Router's scroll restoration keeps
// scroll offsets. The browser keeps an entry's key across reload, Back, and
// Forward, and keeps the session store for the tab.
const STORAGE_KEY = "junior:pane:conversation-origins";
// Enough entries for a long session of Back and Forward.
const MAX_ORIGINS = 100;

/**
 * The history state of a pane row's link. When the row reopens a
 * Conversation, that row stays its origin, so the row owns the page and its
 * next press goes back to its top level.
 */
export function paneRowLinkState(row: PaneRow) {
  return { paneRow: row };
}

function readPaneRow(state: unknown): string | undefined {
  return typeof state === "object" &&
    state !== null &&
    "paneRow" in state &&
    typeof state.paneRow === "string"
    ? state.paneRow
    : undefined;
}

/**
 * Name the list or Space page that opened the Conversation in this history
 * entry, so the pane and Back keep it after a reload, Back, or Forward too.
 * A pane row that reopens it is its origin; else `lastList`, the list or
 * Space page the reader came from. A direct link has none.
 */
export function useConversationOrigin(
  location: Location,
  lastList: ConversationOpener | undefined,
): ConversationOpener | undefined {
  const navigationType = useNavigationType();
  const conversation = location.pathname.startsWith("/conversations/");
  // Read on each render, not memoized by key: a fast Back can return to an
  // entry before the render that saved it shows.
  const saved = conversation ? readOrigins()[location.key] : undefined;
  const paneRow = readPaneRow(location.state);
  const origin = !conversation
    ? undefined
    : isConversationOpener(saved)
      ? saved
      : isConversationOrigin(paneRow)
        ? paneRow
        : navigationType !== NavigationType.Pop
          ? lastList
          : undefined;
  useEffect(() => {
    if (origin && origin !== saved) saveOrigin(location.key, origin);
  }, [location.key, origin, saved]);
  return origin;
}

const originsSchema = z.record(z.string(), z.string());

function readOrigins(): Record<string, string> {
  try {
    const parsed = originsSchema.safeParse(
      JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}"),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    // Without the store, the origin still holds until a reload.
    return {};
  }
}

function saveOrigin(key: string, origin: ConversationOpener) {
  // Keep the newest entries. Object keys keep their insertion order.
  const kept = Object.entries(readOrigins())
    .filter(([entry]) => entry !== key)
    .slice(1 - MAX_ORIGINS);
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries([...kept, [key, origin]])),
    );
  } catch {
    // Without the store, the origin still holds until a reload.
  }
}

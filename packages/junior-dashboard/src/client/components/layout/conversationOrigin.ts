import { useEffect, useMemo } from "react";
import { NavigationType, useNavigationType, type Location } from "react-router";
import * as z from "zod";

import type { InboxView } from "../../review-desk/inboxModel";
import { isInboxView, type PaneRow } from "./paneRows";

// Origins by history entry key, as React Router's scroll restoration keeps
// scroll offsets. The browser keeps an entry's key across reload, Back, and
// Forward, and keeps the session store for the tab.
const STORAGE_KEY = "junior:pane:conversation-origins";
// Enough entries for a long session of Back and Forward.
const MAX_ORIGINS = 100;

/**
 * Name the Inbox view that opened the Conversation in this history entry,
 * so the pane marks it after a reload, Back, or Forward too. An entry that
 * the dashboard did not open itself, such as a direct link, has none.
 * `lastRow` is the row of the page that the reader came from.
 */
export function useConversationOrigin(
  location: Location,
  lastRow: PaneRow,
): InboxView | undefined {
  const navigationType = useNavigationType();
  const saved = useMemo(() => readOrigins()[location.key], [location.key]);
  const origin = isInboxView(saved)
    ? saved
    : navigationType !== NavigationType.Pop && isInboxView(lastRow)
      ? lastRow
      : undefined;
  const conversation = location.pathname.startsWith("/conversations/");
  useEffect(() => {
    if (conversation && origin && origin !== saved)
      saveOrigin(location.key, origin);
  }, [conversation, location.key, origin, saved]);
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
    // Without the store, the pane still marks the origin until a reload.
    return {};
  }
}

function saveOrigin(key: string, origin: InboxView) {
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
    // Without the store, the pane still marks the origin until a reload.
  }
}

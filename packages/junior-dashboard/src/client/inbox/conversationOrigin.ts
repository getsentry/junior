import { useEffect } from "react";
import { NavigationType, useNavigationType, type Location } from "react-router";
import * as z from "zod";

import {
  isConversationOrigin,
  type ConversationOrigin,
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
 * Name the list or Space page that opened the Conversation in this history
 * entry, so the pane and Back keep it after a reload, Back, or Forward too.
 * An entry that the dashboard did not open itself, such as a direct link,
 * has none. `lastList` is the Inbox view, Code page, or Space page that the
 * reader came from, if it was one.
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
  const origin = !conversation
    ? undefined
    : isConversationOpener(saved)
      ? saved
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

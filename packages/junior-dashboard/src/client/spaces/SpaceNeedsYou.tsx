import { useMemo, useState } from "react";
import type { InboxItemPayload } from "@sentry/junior/api/schema";

import { useDetailsPanel } from "../components/DetailsPanel";
import { DetailsCard, DetailsRow } from "../conversations/DetailsList";
import { buildConversations, conversationDisplayTitle } from "../format";
import { codeChangeHead } from "../inbox/codeChangeHead";
import { inboxBundles, type InboxBundle } from "../inbox/inboxItemFormat";
import { useSnoozeInboxItem, type SnoozeEnd } from "../inbox/inboxSnoozes";
import {
  useEveryInboxItemPage,
  useInboxItemsData,
  useLinkedConversationTitles,
} from "../inbox/queries";
import { TranscriptPill } from "../inbox/WaitingQuestions";
import { formatCompactAge } from "../time";
import type { Conversation } from "../types";
import { NeedsYouTitle } from "./NeedsYouTitle";
import { useSpaceConversationsData } from "./queries";
import { SpaceNeedsYouDialog } from "./SpaceNeedsYouDialog";

const NOTHING_AWAY: ReadonlySet<string> = new Set();

/**
 * The open Inbox items of a Space that need the viewer now, in the stacks
 * and order of the Inbox: one stack per root, the one that waited longest
 * first, and each stack oldest first.
 */
function useSpaceNeedsYou(spaceId: string | undefined): InboxBundle[] {
  const { items, query } = useInboxItemsData({
    enabled: Boolean(spaceId),
    needsViewer: true,
    spaceId,
  });
  useEveryInboxItemPage(query);
  // The list keeps the items of the last Space while the new one loads.
  const stale = query.isPlaceholderData;
  return useMemo(() => (stale ? [] : inboxBundles(items)), [items, stale]);
}

/**
 * The root Conversations of the stacks: from the Space's own list, which
 * its details read already, else from each root.
 */
function useRoots(spaceId: string, stacks: readonly InboxBundle[]) {
  const feed = useSpaceConversationsData(spaceId).data;
  const listed = useMemo(
    () =>
      new Map(
        buildConversations(feed?.conversations ?? []).map((conversation) => [
          conversation.id,
          conversation,
        ]),
      ),
    [feed],
  );
  const missing = stacks.flatMap((stack) =>
    stack.conversationId && !listed.has(stack.conversationId)
      ? [stack.conversationId]
      : [],
  );
  const titles = useLinkedConversationTitles(missing);
  const missingTitles = new Map(missing.map((id, at) => [id, titles[at]]));
  return {
    conversationOf: (id: string | undefined) =>
      id === undefined ? undefined : listed.get(id),
    titleOf: (id: string | undefined): string =>
      (id !== undefined && listed.has(id)
        ? conversationDisplayTitle(listed.get(id))
        : id !== undefined
          ? missingTitles.get(id)
          : undefined) ?? "Conversation",
  };
}

/**
 * The Space's items that need the viewer now, one line each, under the
 * title of their root. A click opens the item in a dialog. It shows nothing
 * while nothing needs the viewer.
 */
export function SpaceNeedsYou(props: { spaceId: string }) {
  const bundles = useSpaceNeedsYou(props.spaceId);
  // A snooze hides its item at once. The list drops it after the save.
  const [away, setAway] = useState(NOTHING_AWAY);
  const [open, setOpen] = useState<{ id: string; index: number }>();
  const snoozeItem = useSnoozeInboxItem();
  const stacks = bundles.flatMap((bundle) => {
    const items = bundle.items.filter((item) => !away.has(item.id));
    return items.length > 0 ? [{ ...bundle, items }] : [];
  });
  const roots = useRoots(props.spaceId, stacks);
  const items = stacks.flatMap((stack) => stack.items);
  if (items.length === 0) {
    // The dialog went with the last item, so a new item does not open it.
    if (open) setOpen(undefined);
    return null;
  }
  // An item that closed elsewhere leaves its place to the next one.
  const found = open ? items.findIndex((item) => item.id === open.id) : -1;
  const index = open
    ? found >= 0
      ? found
      : Math.min(open.index, items.length - 1)
    : -1;
  const snooze = (item: InboxItemPayload, end: SnoozeEnd) => {
    setAway((current) => new Set(current).add(item.id));
    void snoozeItem(item, end).finally(() =>
      setAway((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      }),
    );
  };
  return (
    <DetailsCard count={items.length} label="Needs you" title="Needs you">
      <div className="-mx-1.5 -mb-1.5 -mt-1 grid gap-2">
        {stacks.map((stack) => {
          const title = roots.titleOf(stack.conversationId);
          const conversation = roots.conversationOf(stack.conversationId);
          return (
            <section
              aria-label={title}
              className="grid gap-0.5"
              key={stack.key}
            >
              <p className="m-0 truncate px-1.5 pt-0.5 text-xs text-dashboard-text-muted">
                {title}
              </p>
              <ul className="m-0 grid list-none gap-0.5 p-0">
                {stack.items.map((item) => (
                  <li key={item.id}>
                    <NeedsYouRow
                      conversation={conversation}
                      item={item}
                      onOpen={() =>
                        setOpen({ id: item.id, index: items.indexOf(item) })
                      }
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {open ? (
        <SpaceNeedsYouDialog
          conversationOf={roots.conversationOf}
          index={index}
          items={items}
          onClose={() => setOpen(undefined)}
          onShow={(id, at) => setOpen({ id, index: at })}
          snooze={snooze}
          titleOf={roots.titleOf}
        />
      ) : null}
    </DetailsCard>
  );
}

/** One line: an unread dot, the bold title, and its age. */
function NeedsYouRow(props: {
  conversation: Conversation | undefined;
  item: InboxItemPayload;
  onOpen(): void;
}) {
  const { item } = props;
  return (
    <DetailsRow
      icon={
        <span aria-hidden="true" className="grid size-4 place-items-center">
          <span className="size-1.5 rounded-full bg-dashboard-text-solid" />
        </span>
      }
      meta={formatCompactAge(item.createdAt)}
      onClick={props.onOpen}
      title={
        <NeedsYouTitle
          head={codeChangeHead(item, props.conversation)}
          item={item}
        />
      }
    />
  );
}

/**
 * On a Space's Lead page, while its details show in a sheet, say how many
 * items need the viewer. A click opens the details. It shows nothing while
 * nothing needs them.
 */
export function SpaceNeedsYouPill(props: { onOpen(): void; spaceId: string }) {
  const count = useSpaceNeedsYou(props.spaceId).reduce(
    (total, stack) => total + stack.items.length,
    0,
  );
  // Beside the Lead, the details list the items themselves.
  const panel = useDetailsPanel();
  if (panel || count === 0) return null;
  return (
    <TranscriptPill
      icon={
        <span
          aria-hidden="true"
          className="size-1.5 rounded-full bg-dashboard-text-solid"
        />
      }
      onClick={props.onOpen}
    >
      {count} need you
    </TranscriptPill>
  );
}

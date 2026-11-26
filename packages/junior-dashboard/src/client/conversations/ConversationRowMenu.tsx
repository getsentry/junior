import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  ContextMenuItem,
  ContextMenuLinkItem,
  ContextMenuSeparator,
} from "../components/ui/context-menu";
import { buildConversationMarkdown } from "../markdownExport";
import {
  useConversationMenuItems,
  type ConversationMenu,
} from "./conversationMenuItems";
import {
  conversationDetailQueryOptions,
  readConversationEvents,
} from "./queries";
import { loadCompleteConversationTranscript } from "./transcript";

/** What a row menu acts on. The menu reads the detail from the cache. */
export type ConversationRowMenuProps = Omit<
  ConversationMenu,
  "conversation" | "detail" | "getMarkdown"
> & {
  conversation: NonNullable<ConversationMenu["conversation"]>;
};

/**
 * List the row menu groups. Mount it only while a menu is open: it reads the
 * detail from the cache that the row prefetch fills.
 */
function useConversationRowMenuGroups(props: ConversationRowMenuProps) {
  const detail = useQuery({
    ...conversationDetailQueryOptions(props.conversationId),
    enabled: false,
  }).data;
  return useConversationMenuItems({
    ...props,
    detail,
    getMarkdown: detail
      ? async () =>
          buildConversationMarkdown(
            await loadCompleteConversationTranscript({
              detail,
              historyPages: [],
              readPage: (before) =>
                readConversationEvents(props.conversationId, before),
            }),
            props.conversation,
          )
      : undefined,
  });
}

/** Render the row context menu with the rows of the conversation `⋯` menu. */
export function ConversationRowMenu(props: ConversationRowMenuProps) {
  const groups = useConversationRowMenuGroups(props);
  return groups.map((items, index) => (
    <Fragment key={index}>
      {index > 0 ? <ContextMenuSeparator /> : null}
      {items.map((item) =>
        item.href ? (
          <ContextMenuLinkItem
            href={item.href}
            key={item.key}
            rel="noreferrer"
            target="_blank"
          >
            <item.icon aria-hidden="true" />
            {item.label}
          </ContextMenuLinkItem>
        ) : (
          <Fragment key={item.key}>
            <ContextMenuItem
              // The row shows the result of a toggle, so a toggle closes
              // this menu, unlike the `⋯` menu.
              closeOnClick={!item.stayOpen}
              disabled={item.disabled}
              onClick={item.onClick}
            >
              <item.icon aria-hidden="true" />
              {item.label}
            </ContextMenuItem>
            {item.feedback === undefined ? null : (
              <span className="sr-only" role="status">
                {item.feedback}
              </span>
            )}
          </Fragment>
        ),
      )}
    </Fragment>
  ));
}

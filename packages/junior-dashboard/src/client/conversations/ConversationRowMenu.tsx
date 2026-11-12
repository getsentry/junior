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

/**
 * Render the sidebar row menu with the rows of the conversation `⋯` menu.
 * It mounts only while the menu is open, and it reads the detail from the
 * cache that the row prefetch fills.
 */
export function ConversationRowMenu(
  props: Omit<ConversationMenu, "conversation" | "detail" | "getMarkdown"> & {
    conversation: NonNullable<ConversationMenu["conversation"]>;
  },
) {
  const detail = useQuery({
    ...conversationDetailQueryOptions(props.conversationId),
    enabled: false,
  }).data;
  const groups = useConversationMenuItems({
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

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "./ConversationSidebar";
import {
  usePendingArchiveConversationUpdates,
  type PendingArchiveConversationUpdate,
} from "./queries";
import {
  buildConversations,
  conversationPath,
  filterConversationList,
} from "../format";
import type { DashboardCoreData } from "../types";
import type { Conversation } from "../types";
import { cn, dashboardContainerClass } from "../styles";
import { ConversationPage } from "./ConversationPage";

/** Render the personal split-pane conversation workspace at the dashboard root. */
export function ConversationWorkspace(props: { data: DashboardCoreData }) {
  const [query, setQuery] = useState("");
  const [desktop, setDesktop] = useState(false);
  const params = useParams();
  const navigate = useNavigate();
  const selectedId = params.conversationId;
  const feed = useConversationsData(
    props.data.config.authRequired ? props.data.me.user.email : undefined,
  );
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const conversations = useMemo(
    () =>
      applyPendingArchiveUpdates(
        buildConversations(feed.data?.conversations ?? []),
        pendingArchiveUpdates,
      ),
    [feed.data?.conversations, pendingArchiveUpdates],
  );
  const visibleConversations = useMemo(
    () =>
      filterConversationList(conversations, {
        actor: "",
        query,
        source: "",
      }),
    [conversations, query],
  );

  useEffect(() => {
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const first = conversations[0];
    if (desktop && !selectedId && first) {
      navigate(conversationPath(first.id), { replace: true });
    }
  }, [conversations, desktop, navigate, selectedId]);

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid h-full min-h-0 overflow-hidden md:grid-cols-[21rem_minmax(0,1fr)] xl:border-x xl:border-white/[0.07]",
      )}
    >
      <div
        className={
          selectedId
            ? "hidden h-full min-h-0 overflow-hidden md:block"
            : "h-full min-h-0 overflow-hidden"
        }
      >
        <ConversationSidebar
          conversations={visibleConversations}
          error={feed.error?.message}
          loading={feed.isPending}
          onQueryChange={setQuery}
          query={query}
          selectedId={selectedId}
          timeZone={props.data.config.timeZone}
        />
      </div>
      <section
        aria-label="Selected conversation"
        className={
          selectedId
            ? "grid min-h-0 grid-rows-[auto_1fr] overflow-hidden bg-white/[0.012]"
            : "hidden min-h-0 overflow-hidden bg-white/[0.012] md:grid"
        }
      >
        {selectedId ? (
          <>
            <div className="border-b border-white/[0.07] bg-white/[0.025] px-3 py-2.5 md:hidden">
              <Link
                className="inline-flex items-center gap-2 font-mono text-xs text-dashboard-text-muted no-underline hover:text-dashboard-text"
                to="/"
              >
                <ArrowLeft aria-hidden="true" size={15} />
                Your conversations
              </Link>
            </div>
            <div
              aria-label="Conversation transcript"
              className="min-h-0 overflow-y-auto overscroll-contain"
              tabIndex={0}
            >
              <ConversationPage
                conversationId={selectedId}
                data={
                  feed.data
                    ? {
                        conversations: feed.data,
                      }
                    : undefined
                }
                pendingArchiveUpdate={pendingArchiveUpdates.find(
                  (update) => update.conversationId === selectedId,
                )}
              />
            </div>
          </>
        ) : (
          <div className="grid min-h-0 place-items-center px-6 text-center">
            <div>
              <div className="font-display text-lg font-medium text-dashboard-text">
                Select a conversation
              </div>
              <div className="mt-1 font-mono text-xs text-dashboard-text-muted">
                Choose one of your conversations to view its history.
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function applyPendingArchiveUpdates(
  conversations: Conversation[],
  updates: PendingArchiveConversationUpdate[],
): Conversation[] {
  const byId = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );
  for (const update of updates) {
    const existing = byId.get(update.conversationId);
    const conversation =
      existing ??
      (update.conversation
        ? buildConversations([update.conversation])[0]
        : undefined);
    if (!conversation) continue;
    byId.set(update.conversationId, {
      ...conversation,
      archivedAt: update.archived
        ? (conversation.archivedAt ?? conversation.lastSeenAt)
        : undefined,
    });
  }
  return [...byId.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}

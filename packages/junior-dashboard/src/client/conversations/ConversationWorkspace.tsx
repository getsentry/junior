import { useEffect, useMemo, useRef, useState } from "react";
import { Globe2, LockKeyhole, X } from "lucide-react";
import { useNavigate, useParams } from "react-router";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "./ConversationSidebar";
import { ToggleButton } from "../components/Button";
import { ConversationComposer } from "./ConversationComposer";
import {
  useCreateConversation,
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
  const [status, setStatus] = useState<"active" | "archived">("active");
  const params = useParams();
  const navigate = useNavigate();
  const selectedId = params.conversationId;
  const feed = useConversationsData(status);
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const createConversation = useCreateConversation();
  const [creating, setCreating] = useState(false);
  const createSourceId = useRef<string | undefined>(undefined);
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
        status,
      }),
    [conversations, query, status],
  );

  useEffect(() => {
    if (!selectedId) {
      // Root has no selection. Keep create mode only when New set it.
      createSourceId.current = undefined;
      return;
    }
    if (selectedId === createSourceId.current) return;
    setCreating(false);
  }, [selectedId]);

  return (
    <div
      className={cn(
        dashboardContainerClass,
        "grid h-full min-h-0 overflow-hidden md:grid-cols-[21rem_minmax(0,1fr)] xl:border-x xl:border-white/[0.07]",
      )}
    >
      <div
        className={
          selectedId || creating
            ? "hidden h-full min-h-0 overflow-hidden md:block"
            : "h-full min-h-0 overflow-hidden"
        }
      >
        <ConversationSidebar
          conversations={visibleConversations}
          error={feed.error?.message}
          loading={feed.isPending}
          onNewConversation={() => {
            createConversation.reset();
            createSourceId.current = selectedId;
            // New chats are active; leave archived view so the created row can appear.
            setStatus("active");
            setCreating(true);
            if (selectedId) navigate("/", { replace: true });
          }}
          onQueryChange={setQuery}
          onStatusChange={setStatus}
          query={query}
          selectedId={creating ? undefined : selectedId}
          status={status}
          timeZone={props.data.config.timeZone}
        />
      </div>
      <section
        aria-label="Selected conversation"
        className={
          selectedId || creating
            ? "grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-white/[0.012]"
            : "hidden min-h-0 overflow-hidden bg-white/[0.012] md:grid md:grid-rows-[minmax(0,1fr)]"
        }
      >
        {selectedId && !creating ? (
          <ConversationPage
            key={selectedId}
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
        ) : (
          <NewConversationView
            error={
              createConversation.error
                ? "Could not create the conversation. Try again."
                : undefined
            }
            onDismiss={
              creating
                ? () => {
                    createSourceId.current = undefined;
                    setCreating(false);
                  }
                : undefined
            }
            onSubmit={async (message, idempotencyKey, visibility) => {
              const accepted = await createConversation.mutateAsync({
                idempotencyKey,
                message,
                visibility,
              });
              navigate(conversationPath(accepted.conversationId));
            }}
          />
        )}
      </section>
    </div>
  );
}

function NewConversationView(props: {
  error?: string;
  /** Mobile-only escape from create mode back to the conversation list. */
  onDismiss?: () => void;
  onSubmit(
    message: string,
    idempotencyKey: string,
    visibility: "private" | "public",
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const isPublic = visibility === "public";

  // Peer empty-chat pattern: greeting + hero input, no secondary page header.
  // Mobile dismiss is a floating close, not a second nav strip.
  // Use flex + my-auto (not place-items-center) so overflow scrolls from the top.
  return (
    <div className="relative h-full min-h-0 overflow-y-auto overscroll-contain">
      {props.onDismiss ? (
        <button
          aria-label="Back to conversations"
          className="absolute left-2 top-2 z-10 grid size-10 cursor-pointer place-items-center rounded-lg border-0 bg-transparent text-dashboard-text-muted transition-colors hover:bg-white/[0.06] hover:text-dashboard-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/55 md:hidden"
          onClick={props.onDismiss}
          type="button"
        >
          <X aria-hidden="true" size={20} strokeWidth={2} />
        </button>
      ) : null}
      <div className="flex min-h-full flex-col justify-center px-4 py-12 md:px-8">
        <div className="mx-auto flex w-full max-w-xl flex-col items-stretch gap-6 md:max-w-2xl md:gap-8">
          <h2 className="m-0 text-center font-display text-2xl font-medium tracking-[-0.03em] text-dashboard-text md:text-3xl">
            What do you need?
          </h2>
          <ConversationComposer
            draftId="new"
            error={props.error}
            footerStart={
              <div
                aria-label="Conversation visibility"
                className="inline-flex items-center gap-1"
                role="group"
              >
                <ToggleButton
                  onClick={() => setVisibility("public")}
                  pressed={isPublic}
                  type="button"
                  variant="segment"
                >
                  <Globe2 aria-hidden="true" className="mr-1 inline size-3" />
                  Public
                </ToggleButton>
                <ToggleButton
                  onClick={() => setVisibility("private")}
                  pressed={!isPublic}
                  type="button"
                  variant="segment"
                >
                  <LockKeyhole
                    aria-hidden="true"
                    className="mr-1 inline size-3"
                  />
                  Private
                </ToggleButton>
              </div>
            }
            label="Start a conversation"
            restoreDraftOnError
            submitLabel="Send"
            onSubmit={(message, idempotencyKey) =>
              props.onSubmit(message, idempotencyKey, visibility)
            }
          />
        </div>
      </div>
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

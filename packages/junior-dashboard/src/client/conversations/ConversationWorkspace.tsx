import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Globe2, LockKeyhole } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";

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
  const [desktop, setDesktop] = useState(false);
  const params = useParams();
  const navigate = useNavigate();
  const selectedId = params.conversationId;
  const feed = useConversationsData(
    props.data.config.authRequired ? props.data.me.user.email : undefined,
  );
  const pendingArchiveUpdates = usePendingArchiveConversationUpdates();
  const createConversation = useCreateConversation();
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
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
    if (desktop && !creatingRef.current && !creating && !selectedId && first) {
      navigate(conversationPath(first.id), { replace: true });
    }
  }, [conversations, creating, desktop, navigate, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      // Left the route we opened New from. Later selections should exit create.
      createSourceId.current = undefined;
      return;
    }
    if (selectedId === createSourceId.current) return;
    creatingRef.current = false;
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
            creatingRef.current = true;
            setCreating(true);
            if (selectedId) navigate("/", { replace: true });
          }}
          onQueryChange={setQuery}
          query={query}
          selectedId={creating ? undefined : selectedId}
          timeZone={props.data.config.timeZone}
        />
      </div>
      <section
        aria-label="Selected conversation"
        className={
          selectedId || creating
            ? "grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-white/[0.012]"
            : "hidden min-h-0 overflow-hidden bg-white/[0.012] md:grid"
        }
      >
        {creating ? (
          <>
            <div className="border-b border-white/[0.07] bg-white/[0.025] px-3 py-2.5 md:hidden">
              <button
                className="inline-flex items-center gap-2 font-mono text-xs text-dashboard-text-muted hover:text-dashboard-text"
                onClick={() => {
                  creatingRef.current = false;
                  createSourceId.current = undefined;
                  setCreating(false);
                }}
                type="button"
              >
                <ArrowLeft aria-hidden="true" size={15} />
                Your conversations
              </button>
            </div>
            <div className="min-h-0 overflow-y-auto">
              <NewConversationView
                error={
                  createConversation.error
                    ? "Could not create the conversation. Try again."
                    : undefined
                }
                pending={createConversation.isPending}
                onSubmit={async (message, idempotencyKey, visibility) => {
                  const accepted = await createConversation.mutateAsync({
                    idempotencyKey,
                    message,
                    visibility,
                  });
                  navigate(conversationPath(accepted.conversationId));
                }}
              />
            </div>
          </>
        ) : selectedId ? (
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

function NewConversationView(props: {
  error?: string;
  pending: boolean;
  onSubmit(
    message: string,
    idempotencyKey: string,
    visibility: "private" | "public",
  ): Promise<void>;
}) {
  const [visibility, setVisibility] = useState<"private" | "public">("public");
  const isPublic = visibility === "public";

  return (
    <div className="grid min-h-full place-items-center px-4 py-8 md:px-8">
      <div className="w-full max-w-2xl">
        <div className="mb-5">
          <h2 className="m-0 font-display text-2xl font-medium tracking-[-0.03em] text-dashboard-text md:text-3xl">
            New conversation
          </h2>
          <p className="mt-2 font-mono text-xs leading-relaxed text-dashboard-text-muted">
            {isPublic
              ? "This conversation is public. Anyone in this workspace can open its link. Only participants can send messages."
              : "This conversation is private. Only you can open its transcript and send messages."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ToggleButton
              onClick={() => setVisibility("public")}
              pressed={isPublic}
              type="button"
              variant="pill"
            >
              <Globe2 aria-hidden="true" className="mr-1.5 inline size-3" />
              Public
            </ToggleButton>
            <ToggleButton
              onClick={() => setVisibility("private")}
              pressed={!isPublic}
              type="button"
              variant="pill"
            >
              <LockKeyhole
                aria-hidden="true"
                className="mr-1.5 inline size-3"
              />
              Private
            </ToggleButton>
          </div>
        </div>
        <ConversationComposer
          error={props.error}
          label="Start a conversation"
          pending={props.pending}
          submitLabel="Send"
          onSubmit={(message, idempotencyKey) =>
            props.onSubmit(message, idempotencyKey, visibility)
          }
        />
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

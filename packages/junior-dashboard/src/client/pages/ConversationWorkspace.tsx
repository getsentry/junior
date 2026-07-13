import { useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";

import { useConversationsData } from "../api";
import { ConversationSidebar } from "../components/ConversationSidebar";
import {
  buildConversations,
  conversationPath,
  filterConversationList,
} from "../format";
import type { DashboardCoreData } from "../types";
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
  const conversations = useMemo(
    () => buildConversations(feed.data?.conversations ?? []),
    [feed.data?.conversations],
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
            <div className="border-b border-white/[0.07] bg-white/[0.025] px-4 py-3 md:hidden">
              <Link
                className="inline-flex items-center gap-2 font-mono text-[0.7rem] text-white/45 no-underline hover:text-white"
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
              />
            </div>
          </>
        ) : (
          <div className="grid min-h-0 place-items-center px-6 text-center">
            <div>
              <div className="font-display text-lg font-medium text-white">
                Select a conversation
              </div>
              <div className="mt-1 font-mono text-[0.7rem] text-white/30">
                Choose one of your conversations to view its history.
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

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
    <div className="grid h-[calc(100dvh-6.75rem)] min-h-0 min-w-0 md:h-[calc(100dvh-4.25rem)] md:grid-cols-[20rem_minmax(0,1fr)]">
      <div className={selectedId ? "hidden min-h-0 md:block" : "min-h-0"}>
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
            ? "grid min-h-0 grid-rows-[auto_1fr]"
            : "hidden min-h-0 md:grid"
        }
      >
        {selectedId ? (
          <>
            <div className="border-b border-white/10 bg-[#050505] px-3 py-2 md:hidden">
              <Link
                className="inline-flex items-center gap-2 text-[0.82rem] font-semibold text-[#b8b8b8] no-underline hover:text-white"
                to="/"
              >
                <ArrowLeft aria-hidden="true" size={15} />
                Your conversations
              </Link>
            </div>
            <div className="min-h-0 overflow-y-auto">
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
              <div className="text-lg font-semibold text-white">
                Select a conversation
              </div>
              <div className="mt-1 text-[0.86rem] text-[#888]">
                Choose one of your conversations to view its history.
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

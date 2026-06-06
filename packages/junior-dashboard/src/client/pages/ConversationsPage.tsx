import { useSearchParams } from "react-router";

import { ConversationList } from "../components/ConversationList";
import { FilterTabs } from "../components/FilterTabs";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import {
  buildConversations,
  filterConversations,
  formatTime,
  getFilter,
} from "../format";
import type { DashboardData, SessionFilter } from "../types";

/** Render the searchable conversation index from recent turn summaries. */
export function ConversationsPage(props: { data?: DashboardData }) {
  const [params, setParams] = useSearchParams();
  const filter = getFilter(params.get("filter"));
  const sessions = props.data?.sessions.sessions ?? [];
  const conversations = buildConversations(sessions);
  const visibleConversations = filterConversations(conversations, filter);
  const search = params.toString();
  const feedMeta =
    props.data?.sessions.source === "turn_session_records"
      ? `${conversations.length} conversations / ${formatTime(props.data.sessions.generatedAt)}`
      : "waiting for run history feed";

  function updateFilter(nextFilter: SessionFilter) {
    const next = new URLSearchParams(params);
    next.set("filter", nextFilter);
    setParams(next);
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      <section className="min-w-0">
        <Section>
          <SectionHeader
            actions={<FilterTabs current={filter} onChange={updateFilter} />}
          >
            <div>
              <SectionTitle>Conversations</SectionTitle>
              <div className="mt-1 break-words text-[0.82rem] leading-relaxed text-[#b8b8b8]">
                {feedMeta}
              </div>
            </div>
          </SectionHeader>
          <div>
            <ConversationList
              conversations={visibleConversations}
              search={search ? `?${search}` : ""}
            />
          </div>
        </Section>
      </section>
    </div>
  );
}

import { useSearchParams } from "react-router";

import {
  ConversationList,
  FilterTabs,
  Kicker,
  Section,
  SectionHeader,
  SectionTitle,
} from "../components";
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
      ? `${conversations.length} conversations / ${sessions.length} turns / ${formatTime(props.data.sessions.generatedAt)}`
      : "waiting for run history feed";

  function updateFilter(nextFilter: SessionFilter) {
    const next = new URLSearchParams(params);
    next.set("filter", nextFilter);
    setParams(next);
  }

  return (
    <div className="min-w-0 px-4 py-4 md:px-8">
      <section className="min-w-0">
        <Section>
          <SectionHeader
            actions={<FilterTabs current={filter} onChange={updateFilter} />}
          >
            <div>
              <Kicker>Flight Recorder</Kicker>
              <SectionTitle>Conversations</SectionTitle>
              <div className="mt-1 break-words font-mono text-[0.82rem] leading-relaxed text-[#b8b8b8]">
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

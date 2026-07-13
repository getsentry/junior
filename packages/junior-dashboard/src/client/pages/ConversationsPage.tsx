import { useSearchParams } from "react-router";

import { ConversationListToolbar } from "../components/ConversationListControls";
import { ConversationList } from "../components/ConversationList";
import { ConversationDurationChart } from "../components/ConversationDurationChart";
import { FilterTabs } from "../components/FilterTabs";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import {
  buildConversations,
  conversationActorOptions,
  conversationLocationOptions,
  conversationSourceOptions,
  filterConversationList,
  filterConversations,
  formatTime,
  getFilter,
} from "../format";
import type { ConversationFilter, ConversationHistoryData } from "../types";

/** Render the searchable conversation index returned by the REST API. */
export function ConversationsPage(props: { data?: ConversationHistoryData }) {
  const [params, setParams] = useSearchParams();
  const filter = getFilter(params.get("filter"));
  const query = params.get("q") ?? "";
  const actor = params.get("actor") ?? "";
  const location = params.get("location") ?? "";
  const source = params.get("source") ?? "";
  const summaries = props.data?.conversations.conversations ?? [];
  const conversations = buildConversations(summaries);
  const sourceOptions = conversationSourceOptions(conversations);
  const actorOptions = conversationActorOptions(conversations);
  const locationOptions = conversationLocationOptions(conversations);
  const statusConversations = filterConversations(conversations, filter);
  const visibleConversations = filterConversationList(statusConversations, {
    query,
    actor,
    location,
    source,
  });
  const search = params.toString();
  const feedMeta = props.data?.conversations
    ? `${visibleConversations.length} of ${conversations.length} conversations / ${formatTime(props.data.conversations.generatedAt)}`
    : "waiting for conversation feed";

  function updateFilter(nextFilter: ConversationFilter) {
    const next = new URLSearchParams(params);
    next.set("filter", nextFilter);
    setParams(next);
  }

  function updateParam(
    name: "q" | "actor" | "location" | "source",
    value: string,
  ) {
    const next = new URLSearchParams(params);
    const nextValue = name === "q" ? value : value.trim();
    if (nextValue.trim()) {
      next.set(name, nextValue);
    } else {
      next.delete(name);
    }
    setParams(next, { replace: true });
  }

  function clearListFilters() {
    const next = new URLSearchParams(params);
    next.delete("q");
    next.delete("actor");
    next.delete("location");
    next.delete("source");
    setParams(next, { replace: true });
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-screen-xl px-4 py-4 md:px-8">
      <section className="min-w-0">
        <ConversationDurationChart
          conversationSummaries={summaries}
          nowMs={Date.now()}
          timeZone={props.data?.config.timeZone ?? "America/Los_Angeles"}
        />
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
          <ConversationListToolbar
            query={query}
            actor={actor}
            actorOptions={actorOptions}
            location={location}
            locationOptions={locationOptions}
            source={source}
            sourceOptions={sourceOptions}
            onQueryChange={(value) => updateParam("q", value)}
            onActorChange={(value) => updateParam("actor", value)}
            onLocationChange={(value) => updateParam("location", value)}
            onSourceChange={(value) => updateParam("source", value)}
            onClear={clearListFilters}
          />
          <div>
            <ConversationList
              conversations={visibleConversations}
              emptyLabel="No conversations match these filters."
              search={search ? `?${search}` : ""}
            />
          </div>
        </Section>
      </section>
    </div>
  );
}

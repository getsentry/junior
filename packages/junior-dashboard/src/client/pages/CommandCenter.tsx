import { CommandRail } from "../components/CommandRail";
import { ConversationStack } from "../components/ConversationStack";
import { Section } from "../components/Section";
import { SectionHeader } from "../components/SectionHeader";
import { SectionTitle } from "../components/SectionTitle";
import { ConversationDurationChart } from "../components/ConversationDurationChart";
import { ConversationStats } from "../components/ConversationStats";
import { buildConversations, filterRecentConversations } from "../format";
import type { DashboardData } from "../types";

/** Render the dashboard home view with runtime pulse and recent conversations. */
export function CommandCenter(props: {
  data?: DashboardData;
  queryError: Error | null;
}) {
  const summaries = props.data?.conversations.conversations ?? [];
  const nowMs = Date.now();
  const conversations = filterRecentConversations(
    buildConversations(summaries),
    nowMs,
  );

  return (
    <div className="mx-auto grid w-full min-w-0 max-w-screen-xl gap-4 px-4 py-4 md:px-8 lg:grid-cols-[minmax(21rem,0.32fr)_minmax(0,1fr)]">
      <CommandRail data={props.data} error={props.queryError} />

      <section className="min-w-0">
        <ConversationStats
          stats={props.data?.conversationStats}
          statsError={props.data?.conversationStatsError}
          statsLoading={props.data?.conversationStatsLoading}
        />

        <ConversationDurationChart
          conversationSummaries={summaries}
          nowMs={nowMs}
          timeZone={props.data?.config.timeZone ?? "America/Los_Angeles"}
        />

        <Section className="border-[#beaaff]/20">
          <SectionHeader>
            <SectionTitle>Latest Conversations</SectionTitle>
          </SectionHeader>
          <ConversationStack conversations={conversations.slice(0, 4)} />
        </Section>
      </section>
    </div>
  );
}

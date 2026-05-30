import {
  CommandRail,
  ConversationStack,
  TurnDurationChart,
} from "../components";
import { buildConversations } from "../format";
import type { DashboardData } from "../types";

/** Render the dashboard home view with runtime pulse and recent conversations. */
export function CommandCenter(props: {
  data?: DashboardData;
  queryError: Error | null;
}) {
  const sessions = props.data?.sessions.sessions ?? [];
  const conversations = buildConversations(sessions);

  return (
    <div className="layout command-layout">
      <CommandRail data={props.data} error={props.queryError} />

      <section className="stage">
        <TurnDurationChart
          sessions={sessions}
          timeZone={props.data?.config.timeZone ?? "America/Los_Angeles"}
        />

        <section className="section">
          <div className="section-header">
            <div>
              <div className="kicker">Recent</div>
              <div className="section-title">Latest Conversations</div>
            </div>
          </div>
          <ConversationStack conversations={conversations.slice(0, 4)} />
        </section>
      </section>
    </div>
  );
}

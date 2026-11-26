import { useParams } from "react-router";

import { EmptyTelemetry } from "../../../components/EmptyTelemetry";
import { PageFrame } from "../../../components/layout/PageFrame";
import { PaneCollapsedControls } from "../../../components/layout/PaneNav";
import type { ConversationData } from "../../../conversations/queries";
import { UnsentAnswersProvider } from "../../../inbox/UnsentAnswers";
import { useSpaceData } from "../../../spaces/queries";
import { ConversationPage } from "../../conversations/ConversationPage";
import { ConversationDetailLoading } from "../../conversations/ConversationWorkspaceLoading";

/** One Space, which shows its Lead as a Conversation page. */
export function SpacePage(props: {
  /** The Lead's data, from the shell. */
  detail: ConversationData;
}) {
  const { spaceId } = useParams();
  const space = useSpaceData(spaceId);
  const leadId = space.data?.leadConversationId;
  if (leadId) {
    return (
      <section
        aria-label={space.data?.name ?? "Space"}
        className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden bg-dashboard-bg"
      >
        <UnsentAnswersProvider conversationId={leadId} key={leadId}>
          <ConversationPage
            conversationId={leadId}
            detail={props.detail}
            sidebarToggle={<PaneCollapsedControls />}
          />
        </UnsentAnswersProvider>
      </section>
    );
  }
  if (space.error) {
    return (
      <PageFrame title="Space">
        <EmptyTelemetry>This Space is unavailable.</EmptyTelemetry>
      </PageFrame>
    );
  }
  return <ConversationDetailLoading />;
}

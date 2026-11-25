import { useParams } from "react-router";
import type { SpaceReport } from "@sentry/junior/api/schema";

import { EmptyTelemetry } from "../../../components/EmptyTelemetry";
import { PageFrame } from "../../../components/layout/PageFrame";
import { PaneCollapsedControls } from "../../../components/layout/PaneNav";
import type { ConversationData } from "../../../conversations/queries";
import { DashboardApiError } from "../../../http";
import { UnsentAnswersProvider } from "../../../inbox/UnsentAnswers";
import { useSpaceLead } from "../../../lead/Lead";
import { useSpaceData } from "../../../spaces/queries";
import { JoinSpaceButton } from "../../../spaces/SpaceActions";
import { SpaceTile } from "../../../spaces/SpaceTile";
import { ConversationPage } from "../../conversations/ConversationPage";
import { ConversationDetailLoading } from "../../conversations/ConversationWorkspaceLoading";
import { SpaceOverview } from "./SpaceDetails";

/**
 * One Space, which shows its Lead. Members talk to the Lead here, and the
 * Space's details beside it list its Conversations and members. Anyone can
 * open a Space, and read its Lead once a member has talked to it.
 */
export function SpacePage(props: {
  /** The Lead's data, from the shell. */
  detail: ConversationData;
}) {
  const { spaceId } = useParams();
  const space = useSpaceData(spaceId);
  const lead = useSpaceLead(spaceId);
  const leadId = lead.data?.conversationId;
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
  const error = space.error ?? lead.error;
  // A non-member reads no Lead until a member makes it.
  if (
    space.data &&
    !space.data.viewerIsMember &&
    lead.error instanceof DashboardApiError &&
    lead.error.status === 404
  ) {
    return <SpaceWithoutLead space={space.data} />;
  }
  if (error) {
    return (
      <PageFrame title={space.data?.name ?? "Space"}>
        <EmptyTelemetry>This Space is unavailable.</EmptyTelemetry>
      </PageFrame>
    );
  }
  return <ConversationDetailLoading />;
}

/** A Space whose Lead no member has talked to yet, as a non-member sees it. */
function SpaceWithoutLead(props: { space: SpaceReport }) {
  const { space } = props;
  return (
    <PageFrame
      actions={<JoinSpaceButton space={space} />}
      icon={<SpaceTile size="md" space={space} />}
      phoneTitle={space.name}
      title={space.name}
    >
      <div className="grid max-w-xl gap-2">
        <p className="m-0 px-1 pb-2 font-sans text-sm text-dashboard-text-muted">
          No member has talked to this Space&apos;s Lead yet.
        </p>
        <SpaceOverview space={space} />
      </div>
    </PageFrame>
  );
}

import { useState } from "react";
import type { CodeRepositoryReport } from "@sentry/junior/api/schema";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Link, useParams } from "react-router";

import {
  useCodeRepositoryConversationsData,
  useCodeRepositoryData,
} from "../../api";
import { ButtonLink } from "../../components/Button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageRouteLoading } from "../../components/PageRouteLoading";
import {
  timeRangeBucketUnit,
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { buildConversations } from "../../format";
import { CodeActivityChart } from "./CodeActivityChart";
import { CodeChangeRow } from "./CodeChangeRow";
import { CodeSummaryCards } from "./CodeSummaryCards";
import {
  codeRepositoryPath,
  type CodeRepositoryTab,
} from "./codeRepositoryRoutes";
import {
  RecentConversationRow,
  RepositorySection,
  repositoryActivity,
} from "./RepositorySections";
import {
  RepositoryChangesTab,
  RepositoryConversationsTab,
} from "./RepositoryTabs";

const RECENT_ROWS = 5;
const DESCRIPTION = "Conversations and code changes from Junior.";

/** Inline link style used by `ConversationSummary` location links. */
const inlineLinkClass =
  "font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60";

/** Render one repository tab under the shared header and tab bar. */
export function RepositoryPage(props: { tab: CodeRepositoryTab }) {
  const params = useParams();
  const repositoryId = params.repositoryId;
  const [range, setRange] = useState<TimeRangeDays>(30);
  const query = useCodeRepositoryData(repositoryId);
  if (!query.data && !query.error) {
    return (
      <PageRouteLoading
        description={DESCRIPTION}
        label="Loading repository"
        title="Repository"
        variant="stats"
      />
    );
  }
  const data = query.data;
  if (!data) {
    return (
      <PageLayout>
        <BackToCode />
        <EmptyTelemetry>
          This repository is unavailable. It may not have any code changes from
          Junior.
        </EmptyTelemetry>
      </PageLayout>
    );
  }
  const repository = data.repository;
  return (
    <SecondaryNavigation
      ariaLabel="Repository navigation"
      items={[
        {
          end: true,
          label: "Overview",
          to: codeRepositoryPath(repository.id),
        },
        {
          label: "Conversations",
          to: codeRepositoryPath(repository.id, "conversations"),
        },
        {
          label: "Changes",
          to: codeRepositoryPath(repository.id, "changes"),
        },
      ]}
    >
      <PageLayout>
        <BackToCode />
        <PageHeader
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <TimeRangeSelector onChange={setRange} value={range} />
              {repository.url ? (
                <ButtonLink
                  rel="noopener noreferrer"
                  target="_blank"
                  to={repository.url}
                >
                  Open repository
                  <ExternalLink
                    aria-hidden="true"
                    className="size-3.5 shrink-0"
                  />
                </ButtonLink>
              ) : null}
            </div>
          }
          description={<RepositoryDescription data={data} />}
          title={repository.name}
        />
        {props.tab === "overview" ? (
          <RepositoryOverview data={data} range={range} />
        ) : null}
        {props.tab === "conversations" ? (
          <RepositoryConversationsTab repositoryId={repository.id} />
        ) : null}
        {props.tab === "changes" ? (
          <RepositoryChangesTab data={data} range={range} />
        ) : null}
      </PageLayout>
    </SecondaryNavigation>
  );
}

function BackToCode() {
  return (
    <Link
      className="flex w-fit items-center gap-2 font-display text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text"
      to="/code"
    >
      <ArrowLeft aria-hidden="true" size={15} strokeWidth={1.8} />
      Back to code
    </Link>
  );
}

/** Page description, then each Workspace that includes the repository. */
function RepositoryDescription(props: { data: CodeRepositoryReport }) {
  const workspaces = props.data.workspaces;
  if (workspaces.length === 0) return DESCRIPTION;
  return (
    <>
      {DESCRIPTION} / Workspaces{" "}
      {workspaces.map((workspace, index) => (
        <span key={workspace.id}>
          {index > 0 ? ", " : null}
          <Link
            className={inlineLinkClass}
            to={`/system/workspaces/${encodeURIComponent(workspace.id)}`}
          >
            {workspace.name}
          </Link>
        </span>
      ))}
    </>
  );
}

function RepositoryOverview(props: {
  data: CodeRepositoryReport;
  range: TimeRangeDays;
}) {
  const data = props.data;
  const conversationsQuery = useCodeRepositoryConversationsData(
    data.repository.id,
  );
  const conversations = buildConversations(
    conversationsQuery.data?.conversations ?? [],
  ).slice(0, RECENT_ROWS);
  const changes = data.changes.slice(0, RECENT_ROWS);
  return (
    <>
      <CodeSummaryCards summary={data.summary} />
      <div className="grid gap-3 lg:grid-cols-2">
        <RepositorySection
          title="Recent conversations"
          viewAllTo={codeRepositoryPath(data.repository.id, "conversations")}
        >
          {conversations.length > 0 ? (
            conversations.map((conversation) => (
              <RecentConversationRow
                conversation={conversation}
                key={conversation.id}
              />
            ))
          ) : (
            <div className="p-4">
              <EmptyTelemetry>
                {conversationsQuery.error
                  ? "Conversations are unavailable. Try refreshing the dashboard."
                  : conversationsQuery.data
                    ? "No conversations are linked to this repository yet."
                    : "Loading conversations…"}
              </EmptyTelemetry>
            </div>
          )}
        </RepositorySection>
        <RepositorySection
          title="Recent changes"
          viewAllTo={codeRepositoryPath(data.repository.id, "changes")}
        >
          {changes.length > 0 ? (
            changes.map((change) => (
              <CodeChangeRow change={change} key={change.id} />
            ))
          ) : (
            <div className="p-4">
              <EmptyTelemetry>No code changes are recorded yet.</EmptyTelemetry>
            </div>
          )}
        </RepositorySection>
      </div>
      <CodeActivityChart
        bucketUnit={timeRangeBucketUnit(props.range)}
        days={repositoryActivity(data, props.range)}
        range={props.range}
      />
    </>
  );
}

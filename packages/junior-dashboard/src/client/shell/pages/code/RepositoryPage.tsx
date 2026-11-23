import { useState } from "react";
import type { CodeRepositoryReport } from "@sentry/junior/api/schema";
import { GitPullRequest, LayoutDashboard, MessagesSquare } from "lucide-react";
import { Link, useLocation, useParams } from "react-router";

import {
  useCodeRepositoryConversationsData,
  useCodeRepositoryData,
} from "../../../api";
import { EmptyTelemetry } from "../../../components/EmptyTelemetry";
import { PageContentSkeleton } from "../../../components/PageContentSkeleton";
import { ScopeTabs } from "../../../components/filters/ScopeTabs";
import {
  timeRangeBucketUnit,
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../../components/controls/TimeRangeSelector";
import { buildConversations, workspacePath } from "../../../format";
import { CodeActivityChart } from "../../../pages/code/CodeActivityChart";
import { CodeChangeRow } from "../../../pages/code/CodeChangeRow";
import { CodeSummaryCards } from "../../../pages/code/CodeSummaryCards";
import {
  CODE_ALL_PATH,
  codeRepositoryPath,
  type CodeRepositoryTab,
} from "../../../pages/code/codeRepositoryRoutes";
import {
  codeActivity,
  RecentConversationRow,
  RepositorySection,
} from "../../../pages/code/RepositorySections";
import {
  RepositoryChangesTab,
  RepositoryConversationsTab,
  RepositoryRowsLoading,
} from "./RepositoryTabs";
import { cn, dashboardInlineLinkClass } from "../../../styles";
import { OutboundLink } from "../../../components/OutboundLink";
import { getDashboardAgentName } from "../../../agentName";
import { CodePageFrame } from "./CodePageFrame";

const RECENT_ROWS = 5;

/** Code · All, which lists every repository, so Back from one returns there. */
const BACK_TO_CODE = {
  label: "Code",
  to: CODE_ALL_PATH,
};

const TABS = [
  { icon: LayoutDashboard, key: "overview", label: "Overview" },
  { icon: MessagesSquare, key: "conversations", label: "Conversations" },
  { icon: GitPullRequest, key: "changes", label: "Changes" },
] as const;

/** Inline link style used by `ConversationSummary` location links. */
const inlineLinkClass = cn("font-semibold", dashboardInlineLinkClass);

/** Render one repository tab under the shared header and its tabs. */
export function RepositoryPage(props: { tab: CodeRepositoryTab }) {
  const location = useLocation();
  const params = useParams();
  const repositoryId = params["repositoryId"];
  const query = useCodeRepositoryData(repositoryId);
  const data = query.data;
  const name = data?.repository.name ?? "Repository";
  const tabLabel = TABS.find((tab) => tab.key === props.tab)?.label;
  return (
    <CodePageFrame
      back={BACK_TO_CODE}
      documentTitle={props.tab === "overview" ? name : `${name} · ${tabLabel}`}
      phoneTitle={name}
      returnPath={`${location.pathname}${location.search}`}
      tabs={
        data ? (
          <RepositoryTabsNav
            repositoryId={data.repository.id}
            tab={props.tab}
          />
        ) : undefined
      }
      title={name}
    >
      {data ? (
        <>
          {props.tab === "overview" ? <RepositoryOverview data={data} /> : null}
          {props.tab === "conversations" ? (
            <RepositoryConversationsTab repositoryId={data.repository.id} />
          ) : null}
          {props.tab === "changes" ? (
            <RepositoryChangesTab data={data} />
          ) : null}
        </>
      ) : query.error ? (
        <EmptyTelemetry>
          This repository is unavailable. It may not have any code changes from{" "}
          {getDashboardAgentName()}.
        </EmptyTelemetry>
      ) : (
        <PageContentSkeleton label="Loading repository" variant="stats" />
      )}
    </CodePageFrame>
  );
}

/** Overview, Conversations, and Changes of one repository. */
function RepositoryTabsNav(props: {
  repositoryId: string;
  tab: CodeRepositoryTab;
}) {
  return (
    <ScopeTabs
      label="Repository navigation"
      tabs={TABS.map((tab) => ({
        icon: tab.icon,
        iconOnlyOnPhone: true,
        label: tab.label,
        on: tab.key === props.tab,
        path: codeRepositoryPath(props.repositoryId, tab.key),
        search: "",
      }))}
    />
  );
}

/** The repository on its code host, then each Workspace that includes it. */
function RepositoryLinks(props: { data: CodeRepositoryReport }) {
  const { repository, workspaces } = props.data;
  if (!repository.url && workspaces.length === 0) return null;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm text-dashboard-text-muted">
      {repository.url ? (
        <OutboundLink className={inlineLinkClass} href={repository.url}>
          Open repository
        </OutboundLink>
      ) : null}
      {workspaces.length > 0 ? (
        <span>
          Workspaces{" "}
          {workspaces.map((workspace, index) => (
            <span key={workspace.id}>
              {index > 0 ? ", " : null}
              <Link
                className={inlineLinkClass}
                to={workspacePath(workspace.id)}
              >
                {workspace.name}
              </Link>
            </span>
          ))}
        </span>
      ) : null}
    </p>
  );
}

function RepositoryOverview(props: { data: CodeRepositoryReport }) {
  const data = props.data;
  const [range, setRange] = useState<TimeRangeDays>(30);
  const conversationsQuery = useCodeRepositoryConversationsData(
    data.repository.id,
  );
  const conversations = buildConversations(
    conversationsQuery.data?.conversations ?? [],
  ).slice(0, RECENT_ROWS);
  const changes = data.changes.slice(0, RECENT_ROWS);
  return (
    <>
      <RepositoryLinks data={data} />
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
          ) : conversationsQuery.data || conversationsQuery.error ? (
            <div className="p-4">
              <EmptyTelemetry>
                {conversationsQuery.error
                  ? "Conversations are unavailable. Try refreshing the dashboard."
                  : "No conversations are linked to this repository yet."}
              </EmptyTelemetry>
            </div>
          ) : (
            <RepositoryRowsLoading label="Loading conversations" />
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
        actions={<TimeRangeSelector onChange={setRange} value={range} />}
        bucketUnit={timeRangeBucketUnit(range)}
        days={codeActivity(data, range)}
        range={range}
      />
    </>
  );
}

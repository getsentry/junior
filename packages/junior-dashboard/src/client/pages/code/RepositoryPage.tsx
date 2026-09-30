/**
 * Repository detail page: conversations, code changes, automations, and usage
 * for one repository, split into tab routes.
 *
 * Mockup: every tab renders `repositoryMock` for any `:owner/:repo`. Replace
 * it with a repository report before this ships.
 */
import { useState } from "react";
import {
  ArrowLeft,
  Coins,
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  Workflow,
} from "lucide-react";
import { Link } from "react-router";

import { ButtonLink } from "../../components/Button";
import {
  TimeRangeSelector,
  type TimeRangeDays,
} from "../../components/controls/TimeRangeSelector";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { SectionIntro } from "../../components/layout/SectionIntro";
import { SecondaryNavigation } from "../../components/layout/SecondaryNavigation";
import { StatCard } from "../../components/metrics/StatCard";
import {
  formatCompactNumber,
  formatCostSummary,
  formatRelativeTime,
} from "../../format";
import { CodeActivityChart } from "./CodeActivityChart";
import { CodeChangeRow } from "./CodeChangeRow";
import {
  RecentConversationRow,
  RepositoryAutomationList,
  RepositorySection,
} from "./RepositorySections";
import {
  RepositoryAutomationsTab,
  RepositoryChangesTab,
  RepositoryConversationsTab,
  RepositoryUsageTab,
} from "./RepositoryTabs";
import { repositoryMock } from "./repositoryMock";

const repo = repositoryMock;
const basePath = `/code/${repo.owner}/${repo.name}`;
const RECENT_ROWS = 5;

export type RepositoryTab =
  | "overview"
  | "conversations"
  | "changes"
  | "automations"
  | "usage";

/** Tab route segments under `/code/:owner/:repo`. Overview is the bare path. */
export const repositoryTabs: readonly RepositoryTab[] = [
  "overview",
  "conversations",
  "changes",
  "automations",
  "usage",
];

function repositoryTabPath(tab: RepositoryTab): string {
  return tab === "overview" ? basePath : `${basePath}/${tab}`;
}

const navigationItems = [
  { end: true, label: "Overview", to: repositoryTabPath("overview") },
  { label: "Conversations", to: repositoryTabPath("conversations") },
  { label: "Changes", to: repositoryTabPath("changes") },
  { label: "Automations", to: repositoryTabPath("automations") },
  { label: "Usage", to: repositoryTabPath("usage") },
];

/** Inline link style used by `ConversationSummary` location links. */
const inlineLinkClass =
  "font-semibold text-dashboard-text underline decoration-white/20 underline-offset-2 transition-colors hover:decoration-white/60";

/** Render one repository tab under the shared header and tab bar. */
export function RepositoryPage(props: { tab: RepositoryTab }) {
  const [range, setRange] = useState<TimeRangeDays>(30);
  return (
    <SecondaryNavigation
      ariaLabel="Repository navigation"
      items={navigationItems}
    >
      <PageLayout>
        <Link
          className="flex w-fit items-center gap-2 font-display text-sm font-medium text-dashboard-text-muted no-underline transition-colors hover:text-dashboard-text"
          to="/code"
        >
          <ArrowLeft aria-hidden="true" size={15} strokeWidth={1.8} />
          Back to code
        </Link>
        <PageHeader
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <TimeRangeSelector onChange={setRange} value={range} />
              <ButtonLink
                rel="noopener noreferrer"
                target="_blank"
                to={repo.url}
              >
                GitHub
                <ExternalLink
                  aria-hidden="true"
                  className="size-3.5 shrink-0"
                />
              </ButtonLink>
            </div>
          }
          description={<RepositoryDescription />}
          title={`${repo.owner}/${repo.name}`}
        />
        {props.tab === "overview" ? <RepositoryOverview range={range} /> : null}
        {props.tab === "conversations" ? <RepositoryConversationsTab /> : null}
        {props.tab === "changes" ? (
          <RepositoryChangesTab range={range} />
        ) : null}
        {props.tab === "automations" ? <RepositoryAutomationsTab /> : null}
        {props.tab === "usage" ? <RepositoryUsageTab /> : null}
      </PageLayout>
    </SecondaryNavigation>
  );
}

/**
 * Provider, default branch, Workspaces, and last activity. Each Workspace links
 * to its settings.
 */
function RepositoryDescription() {
  return (
    <>
      github / {repo.defaultBranch} / Workspaces{" "}
      {repo.workspaces.map((workspace, index) => (
        <span key={workspace.id}>
          {index > 0 ? ", " : null}
          <Link
            className={inlineLinkClass}
            to={`/system/workspaces/${encodeURIComponent(workspace.id)}`}
          >
            {workspace.name}
          </Link>
        </span>
      ))}{" "}
      / last active {formatRelativeTime(repo.lastActivityAt)}
    </>
  );
}

function RepositoryOverview(props: { range: TimeRangeDays }) {
  const stats = repo.stats;
  const failing = repo.automations.filter(
    (automation) => automation.lastRunStatus === "failed",
  ).length;
  const paused = repo.automations.filter(
    (automation) => automation.status === "paused",
  ).length;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          detail={`${formatCompactNumber(stats.people)} people`}
          icon={MessageSquare}
          label="Conversations"
          value={formatCompactNumber(stats.conversations)}
        />
        <StatCard
          detail={`${stats.merged} merged / ${stats.open} open`}
          icon={GitPullRequest}
          label="Changes"
          value={formatCompactNumber(stats.created)}
        />
        <StatCard
          detail={`${failing} failing / ${paused} paused`}
          icon={Workflow}
          label="Automations"
          value={formatCompactNumber(stats.automations)}
        />
        <StatCard
          detail="Conversations and automations"
          icon={Coins}
          label="Cost"
          value={formatCostSummary({ total: stats.costUsd })}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <RepositorySection
          title="Recent conversations"
          viewAllTo={repositoryTabPath("conversations")}
        >
          {repo.conversations.slice(0, RECENT_ROWS).map((conversation) => (
            <RecentConversationRow
              conversation={conversation}
              key={conversation.id}
            />
          ))}
        </RepositorySection>
        <RepositorySection
          title="Recent changes"
          viewAllTo={repositoryTabPath("changes")}
        >
          {repo.changes.slice(0, RECENT_ROWS).map((change) => (
            <CodeChangeRow change={change} key={change.id} />
          ))}
        </RepositorySection>
      </div>

      <CodeActivityChart
        bucketUnit="day"
        days={repo.activityDays}
        range={props.range}
      />

      <section aria-labelledby="repository-automations" className="grid gap-4">
        <SectionIntro id="repository-automations" title="Automations" />
        <RepositoryAutomationList automations={repo.automations} />
      </section>
    </>
  );
}

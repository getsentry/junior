import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Plus } from "lucide-react";
import type { WorkspaceReport } from "@sentry/junior/api/schema";

import { getDashboardAgentName } from "../../agentName";
import { buttonVariants } from "../../components/ui/button";
import { EmptyTelemetry } from "../../components/EmptyTelemetry";
import { PageContentSkeleton } from "../../components/PageContentSkeleton";
import { Card } from "../../components/layout/Card";
import { PageHeader } from "../../components/layout/PageHeader";
import { PageLayout } from "../../components/layout/PageLayout";
import { useDocumentTitle } from "../../documentTitle";
import { workspacePath } from "../../format";
import { cn } from "../../styles";
import { BaseSandboxCard } from "./BaseSandboxCard";
import { SystemNavigation } from "./SystemNavigation";
import { WorkspaceDeleteDialog } from "./WorkspaceDeleteDialog";
import { WorkspaceDetails } from "./WorkspaceDetails";
import { WorkspaceList } from "./WorkspaceList";
import { useWorkspacesData } from "./workspaceQueries";

const listPath = "/system/workspaces";

/** List install-wide Workspace recipes. The URL selects one for the details panel. */
export function WorkspacesPage() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const deleteSource = useRef<HTMLButtonElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceReport>();
  const workspacesQuery = useWorkspacesData();
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const defaultVcpus = workspacesQuery.data?.defaultVcpus ?? null;
  const selected = workspaces.find((item) => item.id === workspaceId);
  // PageHeader keeps its title after close, so this page owns the tab title.
  useDocumentTitle(selected?.name ?? "Workspaces");

  const closeDetails = () => {
    const trigger = workspaceId
      ? listRef.current?.querySelector<HTMLButtonElement>(
          `[data-workspace-id="${CSS.escape(workspaceId)}"] button`,
        )
      : undefined;
    navigate(listPath);
    (trigger ?? listRef.current)?.focus();
  };

  return (
    <SystemNavigation className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      <div
        className={cn(
          "grid h-full min-h-0 min-w-0",
          workspaceId && "xl:grid-cols-[minmax(0,1fr)_25rem]",
        )}
      >
        <div
          aria-label="Workspaces list"
          className="min-h-0 overflow-y-auto overscroll-contain outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-dashboard-focus"
          ref={listRef}
          role="region"
          tabIndex={0}
        >
          <PageLayout>
            <PageHeader
              actions={
                <Link className={buttonVariants()} to={`${listPath}/new`}>
                  <Plus aria-hidden="true" size={14} />
                  New Workspace
                </Link>
              }
              description={`Named repository recipes ${getDashboardAgentName()} can switch into without cloning each turn.`}
              title="Workspaces"
            />
            {workspacesQuery.error ? (
              <Card padding="sm">
                <EmptyTelemetry>
                  Workspaces failed to load. Try refreshing the dashboard.
                </EmptyTelemetry>
              </Card>
            ) : workspacesQuery.data ? (
              <>
                <BaseSandboxCard
                  defaultVcpus={defaultVcpus}
                  snapshot={workspacesQuery.data.baselineSnapshot}
                />
                <WorkspaceList
                  defaultVcpus={defaultVcpus}
                  onSelect={(workspace) =>
                    navigate(
                      workspace.id === workspaceId
                        ? listPath
                        : workspacePath(workspace.id),
                    )
                  }
                  selectedId={workspaceId}
                  workspaces={workspaces}
                />
              </>
            ) : (
              <PageContentSkeleton label="Loading Workspaces" variant="list" />
            )}
          </PageLayout>
        </div>
        {workspaceId ? (
          <WorkspaceDetails
            defaultVcpus={defaultVcpus}
            key={workspaceId}
            listError={Boolean(workspacesQuery.error)}
            onClose={closeDetails}
            onDelete={(workspace, source) => {
              deleteSource.current = source;
              setDeleteTarget(workspace);
            }}
            workspace={selected}
            workspaceId={workspaceId}
          />
        ) : null}
      </div>
      {deleteTarget ? (
        <WorkspaceDeleteDialog
          onClose={() => setDeleteTarget(undefined)}
          onDeleted={() => {
            if (workspaceId === deleteTarget.id) navigate(listPath);
          }}
          returnFocus={() =>
            deleteSource.current?.isConnected
              ? deleteSource.current
              : (listRef.current ?? false)
          }
          workspace={deleteTarget}
        />
      ) : null}
    </SystemNavigation>
  );
}

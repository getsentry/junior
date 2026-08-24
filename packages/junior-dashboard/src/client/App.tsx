import { useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";

import {
  useConversationsData,
  useDashboardCoreData,
  usePersonalSpendData,
  usePluginUserPagesData,
  useSystemData,
} from "./api";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { LoadingView } from "./components/LoadingView";
import { ProfileMenu } from "./components/ProfileMenu";
import {
  DashboardChrome,
  DashboardChromeProvider,
} from "./components/layout/DashboardChrome";
import { DashboardHeader } from "./components/layout/DashboardHeader";
import { VisualViewportShell } from "./components/layout/VisualViewportShell";
import {
  buildConversations,
  conversationDisplayTitle,
  setDashboardTimeZone,
} from "./format";
import { isNewConversationPath } from "./conversations/conversationRoutes";
import { ConversationWorkspace } from "./conversations/ConversationWorkspace";
import { useConversationData } from "./conversations/queries";
import { ComponentsPage } from "./pages/dev/ComponentsPage";
import { CodePage } from "./pages/code/CodePage";
import { LocationDetailPage } from "./pages/locations/LocationDetailPage";
import { LocationsPage } from "./pages/locations/LocationsPage";
import { PeoplePage } from "./pages/people/PeoplePage";
import { PersonalTokensPage } from "./pages/PersonalTokensPage";
import { PersonProfilePage } from "./pages/people/PersonProfilePage";
import { SettingsPage } from "./pages/SettingsPage";
import { SystemPage } from "./pages/system/SystemPage";
import { SystemPageLayout } from "./pages/system/SystemPageLayout";
import { WorkspaceFormPage } from "./pages/system/WorkspaceFormPage";
import { WorkspacesPage } from "./pages/system/WorkspacesPage";
import { TaskExecutionsPage } from "./pages/tasks/TaskExecutionsPage";
import { TaskRunsPage } from "./pages/tasks/TaskRunsPage";
import { TasksPage } from "./pages/tasks/TasksPage";
import { TasksPageLayout } from "./pages/tasks/TasksPageLayout";
import {
  MemoryPermalinkRoute,
  PluginUserPageRoute,
  pluginUserPagePath,
} from "./pages/user/PluginUserPage";
import { dashboardShellBgClass } from "./styles";
import type { DashboardCoreData } from "./types";

const dashboardNoise = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitchTiles'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.7'/%3E%3C/svg%3E\")",
};

/** Render the dashboard SPA shell and route-level loading states. */
export function DashboardShell() {
  const location = useLocation();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const query = useDashboardCoreData();
  const userPagesQuery = usePluginUserPagesData();
  const data = query.data;
  const userPages = userPagesQuery.data ?? [];
  if (data) {
    setDashboardTimeZone(data.config.timeZone);
  }
  const loading = !data && !query.error;
  const loggedIn = Boolean(data?.config.authRequired && data.me.user.email);
  const personalSpendQuery = usePersonalSpendData(loggedIn);
  const primaryUserPages = loggedIn
    ? userPages.filter((page) => page.navigation === "primary")
    : [];
  const workspace =
    location.pathname === "/" ||
    location.pathname === "/conversations" ||
    location.pathname.startsWith("/conversations/");
  const conversationId = conversationIdFromPath(location.pathname);
  const conversationsQuery = useConversationsData();
  // Detail query shares the page cache so titles outside the top-50 feed stay accurate.
  const conversationDetail = useConversationData(conversationId);
  const mobileConversation = useMemo(() => {
    if (!conversationId) return undefined;
    return buildConversations(
      conversationsQuery.data?.conversations ?? [],
    ).find((item) => item.id === conversationId);
  }, [conversationId, conversationsQuery.data?.conversations]);
  // Create mode is a landing page (normal app chrome), not a thread destination.
  // Only open conversations use the mobile back chevron + title row.
  const mobileConversationTitle = conversationId
    ? conversationDetail.data?.displayTitle?.trim() ||
      conversationDisplayTitle(mobileConversation)
    : undefined;
  const primaryNavItems = [
    { key: "code", label: "Code", to: "/code" },
    ...(loggedIn
      ? [{ key: "tasks", label: "Tasks", to: "/tasks" }]
      : []),
    ...primaryUserPages.map((page) => ({
      key: `${page.pluginName}:${page.id}`,
      label: page.label,
      to: pluginUserPagePath(page.pluginName, page.id),
    })),
    { key: "system", label: "System", to: "/system" },
  ];

  useEffect(() => {
    setMobileNavigationOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigationOpen]);

  async function signOut() {
    await fetch(`${data?.config.authPath ?? "/api/auth"}/sign-out`, {
      credentials: "same-origin",
      method: "POST",
    });
    window.location.assign(data?.config.basePath ?? "/");
  }

  return (
    <DashboardChromeProvider>
      <VisualViewportShell className={dashboardShellBgClass} enabled={workspace}>
        <DashboardChrome
          banner={<ConnectionBanner />}
          header={
            <DashboardHeader
              compact={workspace}
              mobileBackTo={conversationId ? "/" : undefined}
              mobileTitle={mobileConversationTitle}
              mobileNavigationOpen={mobileNavigationOpen}
              navItems={primaryNavItems}
              onMobileNavigationOpenChange={setMobileNavigationOpen}
              mobileIdentity={
                loggedIn ? (
                  <ProfileMenu
                    identity={data!.me}
                    onSignOut={signOut}
                    spend={personalSpendQuery.data}
                    userPages={userPages}
                    variant="sheet-identity"
                  />
                ) : undefined
              }
              mobileProfile={
                loggedIn ? (
                  <ProfileMenu
                    identity={data!.me}
                    onSignOut={signOut}
                    spend={personalSpendQuery.data}
                    userPages={userPages}
                    variant="sheet-links"
                  />
                ) : undefined
              }
              mobileSpend={
                loggedIn ? (
                  <ProfileMenu
                    identity={data!.me}
                    onSignOut={signOut}
                    spend={personalSpendQuery.data}
                    userPages={userPages}
                    variant="sheet-spend"
                  />
                ) : undefined
              }
              profile={
                loggedIn ? (
                  <ProfileMenu
                    identity={data!.me}
                    onSignOut={signOut}
                    spend={personalSpendQuery.data}
                    userPages={userPages}
                  />
                ) : undefined
              }
              version={data?.config.version}
              workspaceActive={workspace}
            />
          }
        />
        <Routes>
        <Route
          element={
            loading ? (
              <TasksPageLayout>
                <LoadingView label="Loading task executions" />
              </TasksPageLayout>
            ) : loggedIn ? (
              <TasksPageLayout>
                <TaskExecutionsPage enabled={loggedIn} />
              </TasksPageLayout>
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/tasks/:kind/:taskId/executions"
        />
        <Route
          element={
            loading ? (
              <TasksPageLayout>
                <LoadingView label="Loading task runs" />
              </TasksPageLayout>
            ) : loggedIn ? (
              <TasksPageLayout>
                <TaskRunsPage enabled={loggedIn} />
              </TasksPageLayout>
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/tasks/runs"
        />
        <Route
          element={
            loading ? (
              <TasksPageLayout>
                <LoadingView label="Loading tasks" />
              </TasksPageLayout>
            ) : loggedIn ? (
              <TasksPageLayout>
                <TasksPage enabled={loggedIn} view="list" />
              </TasksPageLayout>
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/tasks/list/:taskId?"
        />
        <Route
          element={
            loading ? (
              <TasksPageLayout>
                <LoadingView label="Loading tasks" />
              </TasksPageLayout>
            ) : loggedIn ? (
              <TasksPageLayout>
                <TasksPage enabled={loggedIn} view="overview" />
              </TasksPageLayout>
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/tasks"
        />
        <Route
          element={<LegacySystemRedirect section="locations" />}
          path="/locations"
        />
        <Route
          element={<LegacySystemRedirect section="locations" />}
          path="/locations/:locationId"
        />
        <Route
          element={
            loading ? (
              <SystemPageLayout>
                <LoadingView label="Loading locations" />
              </SystemPageLayout>
            ) : (
              <LocationsPage />
            )
          }
          path="/system/locations"
        />
        <Route
          element={
            loading ? (
              <SystemPageLayout>
                <LoadingView label="Loading location" />
              </SystemPageLayout>
            ) : (
              <LocationDetailPage />
            )
          }
          path="/system/locations/:locationId"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading your conversations" />
            ) : data ? (
              <ConversationWorkspace data={data} />
            ) : (
              <LoadingView
                label={query.error?.message ?? "Dashboard unavailable"}
              />
            )
          }
          path="/"
        />
        <Route element={<CodePage />} path="/code" />
        <Route
          element={<Navigate replace to="/" />}
          path="/conversations/new"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading your conversations" />
            ) : data ? (
              <ConversationWorkspace data={data} />
            ) : (
              <LoadingView
                label={query.error?.message ?? "Dashboard unavailable"}
              />
            )
          }
          path="/conversations/:conversationId"
        />
        <Route element={<Navigate replace to="/" />} path="/conversations" />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading components" />
            ) : !data ? (
              <LoadingView
                label={query.error?.message ?? "Dashboard unavailable"}
              />
            ) : data.config.componentGallery ? (
              <ComponentsPage />
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/dev/*"
        />
        <Route
          element={<LegacySystemRedirect section="people" />}
          path="/people"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading profile" />
            ) : (
              <PersonProfilePage />
            )
          }
          path="/people/:email"
        />
        <Route
          element={
            loading ? (
              <SystemPageLayout>
                <LoadingView label="Loading people" />
              </SystemPageLayout>
            ) : (
              <PeoplePage />
            )
          }
          path="/system/people"
        />
        <Route
          element={
            loading ? (
              <SystemPageLayout>
                <LoadingView label="Loading Workspaces" />
              </SystemPageLayout>
            ) : (
              <WorkspacesPage />
            )
          }
          path="/system/workspaces"
        />
        <Route
          element={
            loading ? (
              <SystemPageLayout>
                <LoadingView label="Loading Workspace" />
              </SystemPageLayout>
            ) : (
              <WorkspaceFormPage />
            )
          }
          path="/system/workspaces/new"
        />
        <Route
          element={
            loading ? (
              <SystemPageLayout>
                <LoadingView label="Loading Workspace" />
              </SystemPageLayout>
            ) : (
              <WorkspaceFormPage />
            )
          }
          path="/system/workspaces/:workspaceId"
        />
        <Route
          element={
            loading ? (
              <SystemPageLayout>
                <LoadingView label="Loading system" />
              </SystemPageLayout>
            ) : data ? (
              <SystemRoute coreData={data} />
            ) : (
              <SystemPageLayout>
                <LoadingView
                  label={query.error?.message ?? "Dashboard unavailable"}
                />
              </SystemPageLayout>
            )
          }
          path="/system/*"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading settings" />
            ) : loggedIn ? (
              <SettingsPage identity={data!.me} />
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/settings"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading API tokens" />
            ) : loggedIn ? (
              <PersonalTokensPage />
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/settings/api-tokens"
        />
        <Route
          element={
            loading || userPagesQuery.isPending ? (
              <LoadingView label="Loading memory" />
            ) : loggedIn && userPagesQuery.data ? (
              <MemoryPermalinkRoute pages={userPagesQuery.data} />
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/memories/:memoryId?"
        />
        <Route
          element={
            loading || userPagesQuery.isPending ? (
              <LoadingView label="Loading memories" />
            ) : loggedIn && userPagesQuery.data ? (
              <MemoryPermalinkRoute pages={userPagesQuery.data} />
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/memories/library"
        />
        <Route
          element={
            loading || userPagesQuery.isPending ? (
              <LoadingView label="Loading page" />
            ) : loggedIn && userPagesQuery.data ? (
              <PluginUserPageRoute pages={userPagesQuery.data} />
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/plugins/:pluginName/:pageId/*"
        />
        <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
        <span
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-50 block opacity-[0.018]"
          style={dashboardNoise}
        />
      </VisualViewportShell>
    </DashboardChromeProvider>
  );
}

/** Read the selected conversation id from a workspace detail path. */
function conversationIdFromPath(pathname: string): string | undefined {
  if (isNewConversationPath(pathname)) return undefined;
  const match = pathname.match(/^\/conversations\/([^/]+)$/);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function LegacySystemRedirect(props: { section: "locations" | "people" }) {
  const location = useLocation();
  const legacyPrefix = `/${props.section}`;
  const suffix = location.pathname.slice(legacyPrefix.length);
  return (
    <Navigate
      replace
      to={`/system/${props.section}${suffix}${location.search}${location.hash}`}
    />
  );
}

function SystemRoute(props: { coreData: DashboardCoreData }) {
  const query = useSystemData(props.coreData);
  if (!query.data && !query.error) {
    return (
      <SystemPageLayout>
        <LoadingView label="Loading system" />
      </SystemPageLayout>
    );
  }
  return query.data ? (
    <SystemPage data={query.data} />
  ) : (
    <SystemPageLayout>
      <LoadingView label={query.error?.message ?? "System unavailable"} />
    </SystemPageLayout>
  );
}

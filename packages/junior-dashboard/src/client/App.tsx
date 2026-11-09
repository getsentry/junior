import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Navigate, Route, useLocation, useParams } from "react-router";

import {
  useConversationsData,
  useDashboardCoreData,
  usePersonalSpendData,
  usePluginUserPagesData,
  useSystemData,
} from "./api";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { LoadingView } from "./components/LoadingView";
import { VersionDriftBanner } from "./components/VersionDriftBanner";
import { ProfileMenu } from "./components/ProfileMenu";
import {
  DashboardChrome,
  DashboardChromeProvider,
} from "./components/layout/DashboardChrome";
import { CommandPalette } from "./components/CommandPalette";
import { DashboardHeader } from "./components/layout/DashboardHeader";
import { NavRail, NavRailProvider } from "./components/layout/NavRail";
import { VisualViewportShell } from "./components/layout/VisualViewportShell";
import {
  automationPath,
  buildConversations,
  conversationDetailTitle,
  conversationDisplayTitle,
} from "./format";
import { useDesktopTopBar } from "./navLayout";
import { isNewConversationPath } from "./conversations/conversationRoutes";
import { useDashboardServerVersion } from "./dashboard-version";
import { ConversationWorkspace } from "./conversations/ConversationWorkspace";
import { ConversationWorkspaceLoading } from "./conversations/ConversationWorkspaceLoading";
import { useConversationData } from "./conversations/queries";
import { readConversationStartPosition } from "./conversations/transcriptReadPosition";
import { codeRepositoryTabs } from "./pages/code/codeRepositoryRoutes";
import {
  SettingsRouteLoading,
  type SettingsSectionId,
} from "./pages/settings/SettingsPageLayout";
import {
  SystemPageLayout,
  SystemRouteLoading,
} from "./pages/system/SystemPageLayout";
import { hasWorkspaceDetailsFrame } from "./pages/system/SystemNavigation";
import { systemPluginsPath } from "./pages/system/SystemPlugins";
import {
  locationsHeader,
  PEOPLE_DEFAULT_RANGE,
  peopleHeader,
  systemRouteLoadingHeader,
  workspacesHeader,
} from "./pages/system/systemPageHeaders";
import {
  isMemoryLibraryPath,
  MemoryRouteLoading,
} from "./pages/memory/MemoryPageLayout";
import {
  AutomationsPageLayout,
  hasAutomationDetailsFrame,
  AutomationsRouteLoading,
} from "./pages/automations/AutomationsPageLayout";
import { buildPrimaryNavItems, buildProfileNavItems } from "./primaryNav";
import { TracedRoutes } from "./TracedRoutes";
import {
  ReviewDeskLoading,
  ReviewDeskPage,
} from "./review-desk/ReviewDeskPage";
import { useReviewItemCountData } from "./review-desk/queries";
import { useVersionsPoll } from "./versions";
import type { DashboardCoreData } from "./types";

// Pages outside the conversation workspace load on first visit, so the
// workspace's first paint skips their code and the chart library.
const RepositoryPage = lazy(() =>
  import("./pages/code/RepositoryPage").then((module) => ({
    default: module.RepositoryPage,
  })),
);
const BoardPage = lazy(() =>
  import("./pages/board/BoardPage").then((module) => ({
    default: module.BoardPage,
  })),
);
const CodePage = lazy(() =>
  import("./pages/code/CodePage").then((module) => ({
    default: module.CodePage,
  })),
);
const LocationDetailPage = lazy(() =>
  import("./pages/locations/LocationDetailPage").then((module) => ({
    default: module.LocationDetailPage,
  })),
);
const LocationsPage = lazy(() =>
  import("./pages/locations/LocationsPage").then((module) => ({
    default: module.LocationsPage,
  })),
);
const PeoplePage = lazy(() =>
  import("./pages/people/PeoplePage").then((module) => ({
    default: module.PeoplePage,
  })),
);
const PersonProfilePage = lazy(() =>
  import("./pages/people/PersonProfilePage").then((module) => ({
    default: module.PersonProfilePage,
  })),
);
const ConnectionsPage = lazy(() =>
  import("./pages/settings/ConnectionsPage").then((module) => ({
    default: module.ConnectionsPage,
  })),
);
const McpSettingsPage = lazy(() =>
  import("./pages/settings/McpSettingsPage").then((module) => ({
    default: module.McpSettingsPage,
  })),
);
const PersonalTokensPage = lazy(() =>
  import("./pages/settings/PersonalTokensPage").then((module) => ({
    default: module.PersonalTokensPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./pages/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const SystemPage = lazy(() =>
  import("./pages/system/SystemPage").then((module) => ({
    default: module.SystemPage,
  })),
);
const WorkspaceFormPage = lazy(() =>
  import("./pages/system/WorkspaceFormPage").then((module) => ({
    default: module.WorkspaceFormPage,
  })),
);
const WorkspacesPage = lazy(() =>
  import("./pages/system/WorkspacesPage").then((module) => ({
    default: module.WorkspacesPage,
  })),
);
const AutomationPage = lazy(() =>
  import("./pages/automations/AutomationPage").then((module) => ({
    default: module.AutomationPage,
  })),
);
const AutomationRunsPage = lazy(() =>
  import("./pages/automations/AutomationRunsPage").then((module) => ({
    default: module.AutomationRunsPage,
  })),
);
const AutomationsPage = lazy(() =>
  import("./pages/automations/AutomationsPage").then((module) => ({
    default: module.AutomationsPage,
  })),
);
const MemoryPermalinkRoute = lazy(() =>
  import("./pages/user/PluginUserPage").then((module) => ({
    default: module.MemoryPermalinkRoute,
  })),
);
const PluginUserPageRoute = lazy(() =>
  import("./pages/user/PluginUserPage").then((module) => ({
    default: module.PluginUserPageRoute,
  })),
);
const AdminPage = lazy(() =>
  import("./pages/admin/AdminPage").then((module) => ({
    default: module.AdminPage,
  })),
);

const dashboardNoise = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitchTiles'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.7'/%3E%3C/svg%3E\")",
};

const settingsRoutes: {
  path: string;
  render(data: DashboardCoreData): ReactNode;
  section: SettingsSectionId;
}[] = [
  {
    path: "/settings",
    render: (data) => <SettingsPage identity={data.me} />,
    section: "general",
  },
  {
    path: "/settings/api-tokens",
    render: () => <PersonalTokensPage />,
    section: "api-tokens",
  },
  {
    path: "/settings/connections",
    render: () => <ConnectionsPage />,
    section: "identities",
  },
  {
    path: "/settings/mcp",
    render: () => <McpSettingsPage />,
    section: "mcp",
  },
];

/** Render the dashboard SPA shell and route-level loading states. */
export function DashboardShell() {
  const location = useLocation();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const openCommandPalette = () => setCommandPaletteOpen(true);
  const query = useDashboardCoreData();
  const userPagesQuery = usePluginUserPagesData();
  const data = query.data;
  const serverVersion = useDashboardServerVersion(data?.config.version);
  const userPages = userPagesQuery.data ?? [];
  const loading = !data && !query.error;
  const loggedIn = Boolean(data?.config.authRequired && data.me.user.email);
  const personalSpendQuery = usePersonalSpendData(loggedIn);
  const desktopTopBar = useDesktopTopBar();
  const primaryUserPages = loggedIn
    ? userPages.filter((page) => page.navigation === "primary")
    : [];
  const workspace =
    location.pathname === "/" ||
    location.pathname === "/conversations" ||
    location.pathname.startsWith("/conversations/");
  const conversationId = conversationIdFromPath(location.pathname);
  const conversationsQuery = useConversationsData();
  // The shell owns the open Conversation's data, and the page reads it. On a
  // direct load, this fetch runs beside the dashboard core reads, before the
  // page mounts. One fetch for each visit also brings the unread page.
  const conversationDetail = useConversationData(conversationId, {
    unreadPageAtOpen: readConversationStartPosition() === "unread",
    versionsPoll: true,
  });
  useVersionsPoll(conversationId, Boolean(data));
  const mobileConversation = useMemo(() => {
    if (!conversationId) return undefined;
    return buildConversations(
      conversationsQuery.data?.conversations ?? [],
    ).find((item) => item.id === conversationId);
  }, [conversationId, conversationsQuery.data?.conversations]);
  // Create mode is a landing page (normal app chrome), not a thread destination.
  // Only open conversations use the mobile back chevron + title row.
  const mobileConversationTitle = conversationId
    ? (conversationDetailTitle(conversationDetail.data) ??
      conversationDisplayTitle(mobileConversation))
    : undefined;
  const reviewCountQuery = useReviewItemCountData(loggedIn);
  const primaryNavItems = buildPrimaryNavItems({
    loading,
    loggedIn,
    pathname: location.pathname,
    primaryUserPages,
    reviewCount: reviewCountQuery.data?.needsViewer,
  });
  const profileNavItems = loggedIn
    ? buildProfileNavItems(
        userPages.filter((page) => page.navigation === "profile"),
      )
    : [];

  useEffect(() => {
    setMobileNavigationOpen(false);
  }, [location.pathname]);

  async function signOut() {
    // Better Auth rejects a request body without a JSON content type. On
    // Vercel, a bodiless POST still arrives with an empty body.
    const response = await fetch(
      `${data?.config.authPath ?? "/api/auth"}/sign-out`,
      {
        body: "{}",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    if (!response.ok) {
      throw new Error(`Sign-out returned ${response.status}`);
    }
    window.location.assign(data?.config.basePath ?? "/");
  }

  return (
    <DashboardChromeProvider>
      <NavRailProvider>
        <CommandPalette
          currentConversationId={conversationId}
          navItems={[...primaryNavItems, ...profileNavItems]}
          onOpenChange={setCommandPaletteOpen}
          open={commandPaletteOpen}
        />
        {desktopTopBar ? null : (
          <NavRail
            navItems={primaryNavItems}
            onSearch={openCommandPalette}
            profile={
              loggedIn ? (
                <ProfileMenu
                  identity={data!.me}
                  onSignOut={signOut}
                  spend={personalSpendQuery.data}
                  pages={profileNavItems}
                />
              ) : undefined
            }
            workspaceActive={workspace}
          />
        )}
        <VisualViewportShell
          className="min-w-0 flex-1 bg-dashboard-bg"
          enabled={
            workspace ||
            location.pathname === "/review" ||
            hasAutomationDetailsFrame(location.pathname) ||
            hasWorkspaceDetailsFrame(location.pathname) ||
            isMemoryLibraryPath(location.pathname)
          }
        >
          <DashboardChrome
            desktopTopBar={desktopTopBar}
            banner={
              <>
                <VersionDriftBanner serverVersion={serverVersion} />
                <ConnectionBanner />
              </>
            }
            header={
              <DashboardHeader
                desktopTopBar={desktopTopBar}
                mobileBackTo={conversationId ? "/" : undefined}
                mobileTitle={mobileConversationTitle}
                mobileNavigationOpen={mobileNavigationOpen}
                navItems={primaryNavItems}
                onMobileNavigationOpenChange={setMobileNavigationOpen}
                onSearch={openCommandPalette}
                profile={
                  loggedIn ? (
                    <ProfileMenu
                      identity={data!.me}
                      onSignOut={signOut}
                      spend={personalSpendQuery.data}
                      pages={profileNavItems}
                      variant="top-bar"
                    />
                  ) : undefined
                }
                mobileIdentity={
                  loggedIn ? (
                    <ProfileMenu
                      identity={data!.me}
                      onSignOut={signOut}
                      spend={personalSpendQuery.data}
                      pages={profileNavItems}
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
                      pages={profileNavItems}
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
                      pages={profileNavItems}
                      variant="sheet-spend"
                    />
                  ) : undefined
                }
                version={data?.config.version}
                workspaceActive={workspace}
              />
            }
          />
          <TracedRoutes fallback={<LoadingView label="Loading page" />}>
            <Route element={<LegacyAutomationsRedirect />} path="/tasks" />
            <Route element={<LegacyAutomationsRedirect />} path="/tasks/*" />
            <Route
              element={<LegacyAutomationExecutionsRedirect />}
              path="/automations/:automationId/executions"
            />
            <Route
              element={
                loading || loggedIn ? (
                  <AutomationPage enabled={loggedIn} tab="runs" />
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/automations/:automationId/runs"
            />
            <Route
              element={
                loading || loggedIn ? (
                  <AutomationPage enabled={loggedIn} tab="versions" />
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/automations/:automationId/versions"
            />
            <Route
              element={
                loading || loggedIn ? (
                  <AutomationPage enabled={loggedIn} tab="edit" />
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/automations/:automationId/edit"
            />
            <Route
              element={
                loading || loggedIn ? (
                  <AutomationsPageLayout>
                    <SectionRoute
                      fallback={
                        <AutomationsRouteLoading
                          description="Newest runs across your automations and automations in public destinations."
                          label="Loading automation runs"
                          title="Runs"
                          variant="list"
                        />
                      }
                      loading={loading}
                    >
                      <AutomationRunsPage enabled={loggedIn} />
                    </SectionRoute>
                  </AutomationsPageLayout>
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/automations/runs"
            />
            <Route
              element={
                loading || loggedIn ? (
                  <AutomationsPageLayout>
                    <SectionRoute
                      fallback={
                        <AutomationsRouteLoading
                          description="Find and manage automations across your linked workspaces."
                          label="Loading automations"
                          title="All automations"
                          variant="list"
                        />
                      }
                      loading={loading}
                    >
                      <AutomationsPage enabled={loggedIn} view="list" />
                    </SectionRoute>
                  </AutomationsPageLayout>
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/automations/list"
            />
            <Route
              element={
                loading || loggedIn ? (
                  <AutomationPage enabled={loggedIn} tab="overview" />
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/automations/:automationId"
            />
            <Route
              element={
                loading || loggedIn ? (
                  <AutomationsPageLayout>
                    <SectionRoute
                      fallback={
                        <AutomationsRouteLoading
                          description="Scheduled and event-driven work created by users."
                          label="Loading automations"
                          title="Automations"
                          variant="stats"
                        />
                      }
                      loading={loading}
                    >
                      <AutomationsPage enabled={loggedIn} view="overview" />
                    </SectionRoute>
                  </AutomationsPageLayout>
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/automations"
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
                <SectionRoute
                  fallback={
                    <SystemRouteLoading
                      {...locationsHeader()}
                      label="Loading locations"
                      variant="stats"
                    />
                  }
                  loading={loading}
                >
                  <LocationsPage />
                </SectionRoute>
              }
              path="/system/locations"
            />
            <Route
              element={
                <SectionRoute
                  fallback={
                    <SystemPageLayout>
                      <LoadingView label="Loading location" />
                    </SystemPageLayout>
                  }
                  loading={loading}
                >
                  <LocationDetailPage />
                </SectionRoute>
              }
              path="/system/locations/:locationId"
            />
            <Route
              element={
                loading ? (
                  <ConversationWorkspaceLoading detail={false} />
                ) : data ? (
                  <ConversationWorkspace detail={conversationDetail} />
                ) : (
                  <LoadingView
                    label={query.error?.message ?? "Dashboard unavailable"}
                  />
                )
              }
              path="/"
            />
            <Route
              element={
                loading ? (
                  <ReviewDeskLoading />
                ) : loggedIn ? (
                  <ReviewDeskPage />
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/review"
            />
            {/* The Board is an experiment, so no navigation links to it. */}
            <Route element={<BoardPage />} path="/board" />
            <Route element={<CodePage />} path="/code" />
            {codeRepositoryTabs.map((tab) => (
              <Route
                element={<RepositoryPage tab={tab} />}
                key={tab}
                path={
                  tab === "overview"
                    ? "/code/:repositoryId"
                    : `/code/:repositoryId/${tab}`
                }
              />
            ))}
            <Route
              element={<Navigate replace to="/" />}
              path="/conversations/new"
            />
            <Route
              element={
                loading ? (
                  <ConversationWorkspaceLoading detail />
                ) : data ? (
                  <ConversationWorkspace detail={conversationDetail} />
                ) : (
                  <LoadingView
                    label={query.error?.message ?? "Dashboard unavailable"}
                  />
                )
              }
              path="/conversations/:conversationId"
            />
            <Route
              element={<Navigate replace to="/" />}
              path="/conversations"
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
                <SectionRoute
                  fallback={
                    <SystemRouteLoading
                      {...peopleHeader(PEOPLE_DEFAULT_RANGE)}
                      label="Loading people"
                      variant="stats"
                    />
                  }
                  loading={loading}
                >
                  <PeoplePage />
                </SectionRoute>
              }
              path="/system/people"
            />
            <Route
              element={
                <SectionRoute
                  fallback={
                    <SystemRouteLoading
                      {...workspacesHeader()}
                      label="Loading Workspaces"
                      variant="list"
                    />
                  }
                  loading={loading}
                >
                  <WorkspacesPage />
                </SectionRoute>
              }
              path="/system/workspaces"
            />
            <Route
              element={
                <SectionRoute
                  fallback={
                    <SystemPageLayout>
                      <LoadingView label="Loading Workspace" />
                    </SystemPageLayout>
                  }
                  loading={loading}
                >
                  <WorkspaceFormPage />
                </SectionRoute>
              }
              path="/system/workspaces/new"
            />
            <Route
              element={
                <SectionRoute
                  fallback={
                    <SystemRouteLoading
                      {...workspacesHeader()}
                      label="Loading Workspaces"
                      variant="list"
                    />
                  }
                  loading={loading}
                >
                  <WorkspacesPage />
                </SectionRoute>
              }
              path="/system/workspaces/:workspaceId"
            />
            <Route
              element={
                <SectionRoute
                  fallback={
                    <SystemPageLayout>
                      <LoadingView label="Loading Workspace" />
                    </SystemPageLayout>
                  }
                  loading={loading}
                >
                  <WorkspaceFormPage />
                </SectionRoute>
              }
              path="/system/workspaces/:workspaceId/edit"
            />
            <Route
              element={
                loading ? (
                  <SystemRouteFallback />
                ) : data ? (
                  <Suspense fallback={<SystemRouteFallback />}>
                    <SystemRoute coreData={data} />
                  </Suspense>
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
            {settingsRoutes.map((route) => (
              <Route
                element={
                  loading ? (
                    <SettingsRouteLoading section={route.section} />
                  ) : loggedIn ? (
                    <Suspense
                      fallback={
                        <SettingsRouteLoading section={route.section} />
                      }
                    >
                      {route.render(data!)}
                    </Suspense>
                  ) : (
                    <Navigate replace to="/" />
                  )
                }
                key={route.path}
                path={route.path}
              />
            ))}
            <Route
              element={
                loading || userPagesQuery.isPending ? (
                  <MemoryRouteLoading label="Loading memories" />
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
                  <MemoryRouteLoading label="Loading memory" />
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
                  <LoadingView label="Loading page" />
                ) : loggedIn && userPagesQuery.data ? (
                  <PluginUserPageRoute pages={userPagesQuery.data} />
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/plugins/:pluginName/:pageId/*"
            />
            <Route
              element={
                loading || userPagesQuery.isPending ? (
                  <LoadingView label="Loading admin" />
                ) : loggedIn && data!.me.user.isAdmin && userPagesQuery.data ? (
                  <AdminPage pages={userPagesQuery.data} />
                ) : (
                  <Navigate replace to="/" />
                )
              }
              path="/admin"
            />
            <Route element={<Navigate replace to="/" />} path="*" />
          </TracedRoutes>
          <span
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 z-50 block opacity-[0.018]"
            data-dashboard-noise=""
            style={dashboardNoise}
          />
        </VisualViewportShell>
      </NavRailProvider>
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

function LegacyAutomationsRedirect() {
  const location = useLocation();
  const suffix = location.pathname.slice("/tasks".length);
  return (
    <Navigate
      replace
      to={`/automations${suffix}${location.search}${location.hash}`}
    />
  );
}

/** Execution history became the Runs tab of the Automation page. */
function LegacyAutomationExecutionsRedirect() {
  const location = useLocation();
  const { automationId } = useParams();
  return (
    <Navigate
      replace
      to={`${automationPath(automationId ?? "", "runs")}${location.search}${location.hash}`}
    />
  );
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
  if (!query.data && !query.error) return <SystemRouteFallback />;
  return query.data ? (
    <SystemPage data={query.data} />
  ) : (
    <SystemPageLayout>
      <LoadingView label={query.error?.message ?? "System unavailable"} />
    </SystemPageLayout>
  );
}

/**
 * Show a section's loading state, with its navigation and header, while the
 * shell data or the page code loads. The shared fallback in `TracedRoutes`
 * would replace the whole section with a centered loader.
 */
function SectionRoute(props: {
  children: ReactNode;
  fallback: ReactNode;
  loading: boolean;
}) {
  if (props.loading) return props.fallback;
  return <Suspense fallback={props.fallback}>{props.children}</Suspense>;
}

/** Load a `/system/*` page under the header text that page shows. */
function SystemRouteFallback() {
  const { pathname } = useLocation();
  const plugins = pathname.startsWith(systemPluginsPath);
  return (
    <SystemRouteLoading
      {...systemRouteLoadingHeader(pathname)}
      label={plugins ? "Loading plugins" : "Loading system"}
      variant={plugins ? "list" : "overview"}
    />
  );
}

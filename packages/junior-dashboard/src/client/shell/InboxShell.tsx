import { lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Route, useLocation } from "react-router";

import {
  useConversationsData,
  useDashboardCoreData,
  usePersonalSpendData,
  usePluginUserPagesData,
} from "../api";
import { ConnectionBanner } from "../components/ConnectionBanner";
import { LoadingView } from "../components/LoadingView";
import { VersionDriftBanner } from "../components/VersionDriftBanner";
import { PageContentSkeleton } from "../components/PageContentSkeleton";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { ProfileMenu, SpendSummary } from "./components/ProfileMenu";
import {
  InboxDashboardChrome,
  DashboardChromeProvider,
} from "../components/layout/DashboardChrome";
import { Maximize2, MessageSquareHeart } from "lucide-react";
import {
  CommandPalette,
  paletteGroupForPath,
} from "./components/CommandPalette";
import {
  EventLogShownProvider,
  useEventLogShown,
} from "../components/paletteEventLog";
import { InboxSweepProvider } from "../inbox/useInboxSweep";
import { DashboardHeader } from "./components/layout/DashboardHeader";
import {
  ListPane,
  PaneCollapsedControls,
  PaneNavProvider,
  useZenMode,
  ZEN_MODE_SHORTCUT,
} from "../components/layout/PaneNav";
import {
  useConversationDensity,
  useDensityRoot,
} from "../conversations/conversationDensity";
import { areaForPath } from "../areas";
import { useSidebarFits } from "../conversations/conversationSidebarLayout";
import {
  AREA_PAGE_PARAM,
  AreaSidebar,
  areaListsPages,
} from "../components/layout/AreaSidebar";
import { isCodePath, paneRowForPath } from "../components/layout/paneRows";
import { useNewAutomationAction } from "../pages/automations/newAutomation";
import { InboxDataProvider, useInboxData } from "../inbox/inboxData";
import { InboxNav } from "../inbox/InboxNav";
import { VisualViewportShell } from "../components/layout/VisualViewportShell";
import {
  buildConversations,
  conversationDetailTitle,
  conversationDisplayTitle,
} from "../format";
import { useLead } from "../lead/Lead";
import { useDashboardServerVersion } from "../dashboard-version";
import { ConversationWorkspace } from "./conversations/ConversationWorkspace";
import { ConversationWorkspaceLoading } from "./conversations/ConversationWorkspaceLoading";
import { useConversationData } from "../conversations/queries";
import { useConversationSidebarOpen } from "../conversations/conversationSidebarLayout";
import { readConversationStartPosition } from "../conversations/transcriptReadPosition";
import { codeRepositoryTabs } from "../pages/code/codeRepositoryRoutes";
import { SettingsPageLayout } from "./pages/settings/SettingsPageLayout";
import {
  SystemPageLayout,
  SystemRouteLoading,
} from "../pages/system/SystemPageLayout";
import { hasWorkspaceDetailsFrame } from "../pages/system/SystemNavigation";
import { SystemRoute } from "../pages/system/SystemRoute";
import {
  isMemoryLibraryPath,
  MemoryRouteLoading,
} from "./pages/memory/MemoryPageLayout";
import {
  AutomationsPageLayout,
  hasAutomationDetailsFrame,
  AutomationsRouteLoading,
} from "./pages/automations/AutomationsPageLayout";
import { conversationIdFromPath, inboxMobileHeader } from "./inboxMobileHeader";
import { buildPrimaryNavItems, buildProfileNavItems } from "./primaryNav";
import { TracedRoutes } from "../TracedRoutes";
import { InboxRedirect, isOldInboxLink } from "../inbox/InboxRedirect";
import {
  LegacyAutomationExecutionsRedirect,
  LegacyAutomationListRedirect,
  LegacyAutomationsRedirect,
  LegacySystemRedirect,
} from "./legacyRedirects";
import { NAV_PAGES } from "../navPages";
import { LinkedSnooze } from "../inbox/LinkedSnooze";
import { InboxListProvider, useInboxReturnPath } from "../inbox/inboxListState";
import { useInboxTabCount } from "../inbox/inboxTabIcon";
import { cn } from "../styles";
import { ComfortableDensityContext, UiShellContext } from "../uiShell";
import { useVersionsPoll } from "../versions";
import { getDashboardAgentName } from "../agentName";
import { canSendFeedback } from "../sentry";

// Pages outside the conversation workspace load on first visit, so the
// workspace's first paint skips their code and the chart library.
const RepositoryPage = lazy(() =>
  import("./pages/code/RepositoryPage").then((module) => ({
    default: module.RepositoryPage,
  })),
);
const CodePage = lazy(() =>
  import("./pages/code/CodePage").then((module) => ({
    default: module.CodePage,
  })),
);
const LocationDetailPage = lazy(() =>
  import("../pages/locations/LocationDetailPage").then((module) => ({
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
  import("../pages/people/PersonProfilePage").then((module) => ({
    default: module.PersonProfilePage,
  })),
);
const SettingsPage = lazy(() =>
  import("./pages/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage,
  })),
);
const WorkspaceFormPage = lazy(() =>
  import("../pages/system/WorkspaceFormPage").then((module) => ({
    default: module.WorkspaceFormPage,
  })),
);
const WorkspacesPage = lazy(() =>
  import("../pages/system/WorkspacesPage").then((module) => ({
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
  import("../pages/admin/AdminPage").then((module) => ({
    default: module.AdminPage,
  })),
);

const dashboardNoise = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitchTiles'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.7'/%3E%3C/svg%3E\")",
};

// The Settings sections used to be pages. Their old links open the section.
// They keep their query, such as the token name that `?name=` prefills.
function LegacySettingsRedirect(props: { anchor: string }) {
  const { search } = useLocation();
  return <Navigate replace to={`/settings${search}#${props.anchor}`} />;
}

const legacySettingsPaths = [
  ["/settings/api-tokens", "api-tokens"],
  ["/settings/connections", "identities"],
  ["/settings/mcp", "mcp"],
] as const;

/** Render the dashboard SPA shell and route-level loading states. */
function InboxRoutes() {
  // The Inbox list keeps its place while a Conversation replaces it, and
  // the phone header's Back returns to it.
  return (
    <InboxListProvider>
      <ShellInboxData>
        <Shell />
      </ShellInboxData>
    </InboxListProvider>
  );
}

/**
 * One Inbox read feeds the pane on every page, the phone navigation, and
 * the Inbox lists.
 */
function ShellInboxData(props: { children: ReactNode }) {
  const signedIn = Boolean(useDashboardCoreData().data?.me.user.email);
  return (
    <InboxDataProvider signedIn={signedIn}>{props.children}</InboxDataProvider>
  );
}

function Shell() {
  const location = useLocation();
  const inboxReturnPath = useInboxReturnPath();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const openCommandPalette = () => setCommandPaletteOpen(true);
  const query = useDashboardCoreData();
  const userPagesQuery = usePluginUserPagesData();
  const data = query.data;
  const serverVersion = useDashboardServerVersion(data?.config.version);
  const userPages = userPagesQuery.data ?? [];
  const loading = !data && !query.error;
  // With auth off, the server still resolves the local viewer for every API
  // read, so that viewer counts as signed in.
  const loggedIn = Boolean(data?.me.user.email);
  const personalSpendQuery = usePersonalSpendData(loggedIn);
  const [paneOpen, setPaneOpen] = useConversationSidebarOpen();
  const primaryUserPages = loggedIn
    ? userPages.filter((page) => page.navigation === "primary")
    : [];
  const workspace =
    location.pathname === NAV_PAGES.lead.to ||
    location.pathname === NAV_PAGES.inbox.to ||
    location.pathname === "/conversations" ||
    location.pathname.startsWith("/conversations/");
  const newAutomation = useNewAutomationAction();
  useDensityRoot();
  const conversationId = conversationIdFromPath(location.pathname);
  const conversationsQuery = useConversationsData();
  // Home shows the viewer's Lead.
  const lead = useLead(loggedIn);
  const leadId = lead.data?.conversationId;
  const openConversationId =
    conversationId ??
    (location.pathname === NAV_PAGES.lead.to ? leadId : undefined);
  // The shell owns the open Conversation's data, and the page reads it. On a
  // direct load, this fetch runs beside the dashboard core reads, before the
  // page mounts. One fetch for each visit also brings the unread page.
  const conversationDetail = useConversationData(openConversationId, {
    unreadPageAtOpen: readConversationStartPosition() === "unread",
  });
  useVersionsPoll(openConversationId, Boolean(data));
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
  // To do's own count, so the header and the tab match its cards.
  const inboxCount = useInboxData().todoCount;
  useInboxTabCount(inboxCount);
  const primaryNavItems = buildPrimaryNavItems({
    inboxCount,
    loading,
    loggedIn,
    pathname: location.pathname,
    primaryUserPages,
  });
  const inboxHeader = inboxMobileHeader(
    location.pathname,
    location.search,
    inboxReturnPath,
  );
  const profileNavItems = loggedIn
    ? buildProfileNavItems(
        userPages.filter((page) => page.navigation === "profile"),
      )
    : [];
  // Away from the destinations, the pane lists the area's pages. Phones
  // show that list first at the area's root, then each page with a way
  // back to it.
  // An area of sections on one page, such as Settings, opens that page.
  const sidebarFits = useSidebarFits();
  const area = areaForPath(
    location.pathname,
    { primary: primaryNavItems, profile: profileNavItems },
    paneRowForPath(location, primaryNavItems, undefined) !== undefined,
  );
  const areaListed =
    area !== undefined && Boolean(area.root) && areaListsPages(area);
  const areaListFirst =
    !sidebarFits &&
    areaListed &&
    location.pathname === area?.root &&
    !new URLSearchParams(location.search).has(AREA_PAGE_PARAM);
  const areaBack = !sidebarFits && areaListed && !areaListFirst;

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
      <PaneNavProvider
        // Without embedded bootstrap data, the viewer is unknown at first, so
        // the Lead may still be coming.
        leadPending={loading || (loggedIn && lead.isPending)}
        navItems={primaryNavItems}
        onOpenChange={setPaneOpen}
        onSearch={openCommandPalette}
        open={paneOpen}
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
        spend={
          loggedIn ? (
            <SpendSummary labelled spend={personalSpendQuery.data} />
          ) : undefined
        }
        workspaceActive={workspace}
      >
        <ShellCommandPalette
          pathname={location.pathname}
          currentConversationId={conversationId}
          navItems={[...primaryNavItems, ...profileNavItems]}
          onOpenChange={setCommandPaletteOpen}
          open={commandPaletteOpen}
        />
        {/* The Inbox mounts its own pane. An area lists its pages; every
            other page lists the destinations. */}
        {workspace ? null : (
          <div
            className={cn(
              "sticky top-0 h-dvh shrink-0 max-md:hidden",
              !paneOpen && "md:hidden",
            )}
          >
            {area ? (
              <ListPane>
                <AreaSidebar area={area} />
              </ListPane>
            ) : (
              <ListPane
                newAction={
                  location.pathname.startsWith("/automations")
                    ? newAutomation
                    : undefined
                }
                scrollList="destinations"
              >
                <InboxNav />
              </ListPane>
            )}
          </div>
        )}
        <VisualViewportShell
          className="min-w-0 flex-1 bg-dashboard-bg"
          enabled={
            workspace ||
            hasAutomationDetailsFrame(location.pathname) ||
            hasWorkspaceDetailsFrame(location.pathname) ||
            isMemoryLibraryPath(location.pathname)
          }
        >
          <InboxDashboardChrome
            // Conversation pages, the Automations list, and Code put these
            // in their own header.
            desktopControls={
              workspace ||
              location.pathname === "/automations" ||
              isCodePath(location.pathname) ? undefined : (
                <PaneCollapsedControls />
              )
            }
            banner={
              <>
                <VersionDriftBanner serverVersion={serverVersion} />
                <ConnectionBanner />
              </>
            }
            header={
              <DashboardHeader
                mobileBackTo={areaBack ? area?.root : inboxHeader.backTo}
                mobileBackLabel={
                  areaBack ? `Back to ${area?.label}` : inboxHeader.backLabel
                }
                mobileTitle={
                  areaBack
                    ? area?.label
                    : (inboxHeader.title ?? mobileConversationTitle)
                }
                mobileNavigationOpen={mobileNavigationOpen}
                navItems={primaryNavItems}
                onMobileNavigationOpenChange={setMobileNavigationOpen}
                onSearch={openCommandPalette}
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
          {areaListFirst && area ? (
            <AreaSidebar area={area} phone />
          ) : (
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
                  loading ? (
                    <AutomationsPageLayout>
                      <AutomationsRouteLoading
                        description="Newest runs across your automations and automations in public destinations."
                        label="Loading automation runs"
                        title="Runs"
                      />
                    </AutomationsPageLayout>
                  ) : loggedIn ? (
                    <AutomationsPageLayout>
                      <AutomationRunsPage enabled={loggedIn} />
                    </AutomationsPageLayout>
                  ) : (
                    <Navigate replace to="/" />
                  )
                }
                path="/automations/runs"
              />
              <Route
                element={<LegacyAutomationListRedirect />}
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
                    <AutomationsPage enabled={loggedIn} />
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
                  loading ? (
                    <SystemRouteLoading
                      description="Public destinations and their conversation activity."
                      label="Loading locations"
                      title="Locations"
                      variant="stats"
                    />
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
                    <ConversationWorkspaceLoading detail />
                  ) : !data ? (
                    <LoadingView
                      label={query.error?.message ?? "Dashboard unavailable"}
                    />
                  ) : !loggedIn ? (
                    // Without an account there is no Lead.
                    <Navigate replace to={NAV_PAGES.inbox.to} />
                  ) : leadId ? (
                    <ConversationWorkspace
                      detail={conversationDetail}
                      leadId={leadId}
                    />
                  ) : lead.error ? (
                    <LoadingView label={lead.error.message} />
                  ) : (
                    <ConversationWorkspaceLoading detail />
                  )
                }
                path="/"
              />
              <Route
                element={
                  isOldInboxLink(location.search) ? (
                    <InboxRedirect />
                  ) : loading ? (
                    <ConversationWorkspaceLoading detail={false} />
                  ) : data ? (
                    <ConversationWorkspace detail={conversationDetail} />
                  ) : (
                    <LoadingView
                      label={query.error?.message ?? "Dashboard unavailable"}
                    />
                  )
                }
                path="/inbox"
              />
              <Route element={<InboxRedirect />} path="/review" />
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
                element={<Navigate replace to={NAV_PAGES.inbox.to} />}
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
                  loading ? (
                    <SystemRouteLoading
                      description="People, activity, and model spend."
                      label="Loading people"
                      title="People"
                      variant="stats"
                    />
                  ) : (
                    <PeoplePage />
                  )
                }
                path="/system/people"
              />
              <Route
                element={
                  loading ? (
                    <SystemRouteLoading
                      description={`Repository recipes ${getDashboardAgentName()} can switch into.`}
                      label="Loading Workspaces"
                      title="Workspaces"
                      variant="list"
                    />
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
                    <SystemRouteLoading
                      description={`Repository recipes ${getDashboardAgentName()} can switch into.`}
                      label="Loading Workspaces"
                      title="Workspaces"
                      variant="list"
                    />
                  ) : (
                    <WorkspacesPage />
                  )
                }
                path="/system/workspaces/:workspaceId"
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
                path="/system/workspaces/:workspaceId/edit"
              />
              <Route
                element={
                  loading ? (
                    <SystemRouteLoading
                      description="Runtime health, model usage, and loaded capabilities."
                      label="Loading system"
                      title="System"
                      variant="overview"
                    />
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
                    <SettingsPageLayout>
                      <PageContentSkeleton label="Loading settings" />
                    </SettingsPageLayout>
                  ) : loggedIn ? (
                    <SettingsPage identity={data!.me} />
                  ) : (
                    <Navigate replace to="/" />
                  )
                }
                path="/settings"
              />
              {legacySettingsPaths.map(([path, anchor]) => (
                <Route
                  element={<LegacySettingsRedirect anchor={anchor} />}
                  key={path}
                  path={path}
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
                  ) : loggedIn &&
                    data!.me.user.isAdmin &&
                    userPagesQuery.data ? (
                    <AdminPage pages={userPagesQuery.data} />
                  ) : (
                    <Navigate replace to="/" />
                  )
                }
                path="/admin"
              />
              <Route element={<Navigate replace to="/" />} path="*" />
            </TracedRoutes>
          )}
          <LinkedSnooze />
          <span
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 z-50 block opacity-[0.018]"
            data-dashboard-noise=""
            style={dashboardNoise}
          />
        </VisualViewportShell>
      </PaneNavProvider>
    </DashboardChromeProvider>
  );
}

/**
 * The command palette, with Zen mode among its actions where it exists, and
 * Send feedback where the profile menu offers it.
 */
function ShellCommandPalette({
  pathname,
  ...props
}: Omit<Parameters<typeof CommandPalette>[0], "actions" | "activeGroup"> & {
  pathname: string;
}) {
  const zen = useZenMode();
  const eventLogShown = useEventLogShown();
  const reader = useDashboardCoreData().data?.me.user;
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The profile menu's own rule: a signed-in viewer and a DSN to send to.
  const feedback = Boolean(reader?.email) && canSendFeedback();
  return (
    <>
      <CommandPalette
        {...props}
        activeGroup={paletteGroupForPath(pathname, eventLogShown)}
        actions={[
          ...(zen.available
            ? [
                {
                  icon: Maximize2,
                  id: "zen-mode",
                  label: zen.active ? "Leave Zen mode" : "Zen mode",
                  run: zen.toggle,
                  shortcut: ZEN_MODE_SHORTCUT,
                },
              ]
            : []),
          ...(feedback
            ? [
                {
                  icon: MessageSquareHeart,
                  id: "send-feedback",
                  label: "Send feedback",
                  run: () => setFeedbackOpen(true),
                },
              ]
            : []),
        ]}
      />
      {feedbackOpen && reader ? (
        <FeedbackDialog
          onClose={() => setFeedbackOpen(false)}
          reader={reader}
        />
      ) : null}
    </>
  );
}

/**
 * Render the new dashboard UI for users who turned on `experimentalUi`.
 * Its providers live here, so the current UI does not load them.
 */
export function InboxShell() {
  const [density] = useConversationDensity();
  return (
    <UiShellContext value="inbox">
      <ComfortableDensityContext value={density === "comfortable"}>
        <InboxSweepProvider>
          <EventLogShownProvider>
            <InboxRoutes />
          </EventLogShownProvider>
        </InboxSweepProvider>
      </ComfortableDensityContext>
    </UiShellContext>
  );
}

import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router";

import {
  useDashboardCoreData,
  usePersonalSpendData,
  usePluginUserPagesData,
  useSystemData,
} from "./api";
import { getDashboardAgentName } from "./agentName";
import { LoadingView } from "./components/LoadingView";
import { JuniorLogo } from "./components/JuniorLogo";
import { ProfileMenu } from "./components/ProfileMenu";
import { setDashboardTimeZone } from "./format";
import { ConversationWorkspace } from "./conversations/ConversationWorkspace";
import { ComponentsPage } from "./pages/dev/ComponentsPage";
import { LocationDetailPage } from "./pages/locations/LocationDetailPage";
import { LocationsPage } from "./pages/locations/LocationsPage";
import { PeoplePage } from "./pages/people/PeoplePage";
import { PersonalTokensPage } from "./pages/PersonalTokensPage";
import { PersonProfilePage } from "./pages/people/PersonProfilePage";
import { SystemPage } from "./pages/system/SystemPage";
import { TasksPage } from "./pages/tasks/TasksPage";
import {
  MemoryPermalinkRoute,
  PluginUserPageRoute,
  pluginUserPagePath,
} from "./pages/user/PluginUserPage";
import {
  cn,
  dashboardContainerClass,
  dashboardInteractiveTextClass,
} from "./styles";
import type { DashboardCoreData } from "./types";

const dashboardBackground = {
  backgroundColor: "#050507",
  backgroundImage:
    "radial-gradient(ellipse at 50% 0%, transparent 0%, #050507 70%), linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px)",
  backgroundSize: "100% 100%, 40px 40px, 40px 40px",
};

const dashboardNoise = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitchTiles'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.7'/%3E%3C/svg%3E\")",
};

/** Render the dashboard SPA shell and route-level loading states. */
export function DashboardShell() {
  const location = useLocation();
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
  const conversationDetail =
    location.pathname.startsWith("/conversations/") &&
    location.pathname !== "/conversations/";

  async function signOut() {
    await fetch(`${data?.config.authPath ?? "/api/auth"}/sign-out`, {
      credentials: "same-origin",
      method: "POST",
    });
    window.location.assign(data?.config.basePath ?? "/");
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "shrink-0 whitespace-nowrap rounded-md px-2.5 py-2 font-mono text-xs font-medium uppercase tracking-[0.08em] no-underline transition-colors sm:tracking-[0.12em]",
      isActive
        ? "bg-cyan-300/[0.1] text-cyan-50"
        : cn("hover:bg-white/[0.035]", dashboardInteractiveTextClass),
    );

  return (
    <main
      className={cn(
        "relative grid font-mono text-dashboard-text",
        workspace
          ? cn(
              "h-dvh min-h-0 overflow-hidden",
              // Hidden header is removed from the grid, so mobile conversation
              // detail must use a single full-height row or the workspace lands
              // in `auto` and the transcript height chain breaks.
              conversationDetail
                ? "grid-rows-[minmax(0,1fr)] md:grid-rows-[auto_minmax(0,1fr)]"
                : "grid-rows-[auto_minmax(0,1fr)]",
            )
          : "min-h-screen grid-rows-[auto_1fr]",
      )}
      style={dashboardBackground}
    >
      <header
        className={cn(
          "sticky top-0 z-10 border-b border-white/[0.05] bg-[#050507]/95",
          conversationDetail && "max-md:hidden",
        )}
      >
        <div
          className={cn(
            dashboardContainerClass,
            "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 md:gap-x-5 md:gap-y-3 md:py-4",
            loggedIn
              ? "md:grid-cols-[auto_minmax(0,1fr)_auto]"
              : "md:grid-cols-[auto_minmax(0,1fr)]",
            workspace ? "md:px-4" : "md:px-8",
          )}
        >
          <Link
            aria-label={`${getDashboardAgentName()} home`}
            className="flex min-w-0 max-w-full items-center justify-self-start text-inherit no-underline"
            to="/"
          >
            <JuniorLogo />
          </Link>
          <nav className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] md:col-span-1 md:col-start-2 md:row-start-1 md:justify-self-start md:overflow-visible [&::-webkit-scrollbar]:hidden">
            <Link
              aria-current={workspace ? "page" : undefined}
              className={navLinkClass({ isActive: workspace })}
              to="/"
            >
              Conversations
            </Link>
            {loggedIn ? (
              <NavLink className={navLinkClass} to="/tasks">
                Tasks
              </NavLink>
            ) : null}
            {primaryUserPages.map((page) => (
              <NavLink
                className={navLinkClass}
                key={`${page.pluginName}:${page.id}`}
                to={pluginUserPagePath(page.pluginName, page.id)}
              >
                {page.label}
              </NavLink>
            ))}
            <NavLink className={navLinkClass} to="/system">
              System
            </NavLink>
          </nav>
          {loggedIn ? (
            <div className="col-start-2 row-start-1 justify-self-end md:col-start-3">
              <ProfileMenu
                identity={data!.me}
                onSignOut={signOut}
                spend={personalSpendQuery.data}
                userPages={userPages}
              />
            </div>
          ) : null}
        </div>
      </header>

      <Routes>
        <Route
          element={
            loading ? (
              <LoadingView label="Loading tasks" />
            ) : loggedIn ? (
              <TasksPage enabled={loggedIn} />
            ) : (
              <Navigate replace to="/" />
            )
          }
          path="/tasks/:taskId?"
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
              <LoadingView label="Loading locations" />
            ) : (
              <LocationsPage />
            )
          }
          path="/system/locations"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading location" />
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
            loading ? <LoadingView label="Loading people" /> : <PeoplePage />
          }
          path="/system/people"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading system" />
            ) : data ? (
              <SystemRoute coreData={data} />
            ) : (
              <LoadingView
                label={query.error?.message ?? "Dashboard unavailable"}
              />
            )
          }
          path="/system/*"
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
    </main>
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
  if (!query.data && !query.error) {
    return <LoadingView label="Loading system" />;
  }
  return query.data ? (
    <SystemPage data={query.data} />
  ) : (
    <LoadingView label={query.error?.message ?? "System unavailable"} />
  );
}

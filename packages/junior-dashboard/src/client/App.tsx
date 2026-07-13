import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from "react-router";

import { useDashboardCoreData, useSystemData } from "./api";
import { LoadingView } from "./components/LoadingView";
import { JuniorLogo } from "./components/JuniorLogo";
import { ProfileMenu } from "./components/ProfileMenu";
import { setDashboardTimeZone } from "./format";
import { ConversationWorkspace } from "./pages/ConversationWorkspace";
import { LocationDetailPage } from "./pages/locations/LocationDetailPage";
import { LocationsPage } from "./pages/locations/LocationsPage";
import { PeoplePage } from "./pages/people/PeoplePage";
import { PersonProfilePage } from "./pages/people/PersonProfilePage";
import { SystemPage } from "./pages/system/SystemPage";
import { cn, dashboardContainerClass } from "./styles";

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
  const data = query.data;
  if (data) {
    setDashboardTimeZone(data.config.timeZone);
  }
  const loading = !data && !query.error;
  const loggedIn = Boolean(data?.config.authRequired && data.me.user.email);
  const workspace =
    location.pathname === "/" ||
    location.pathname === "/conversations" ||
    location.pathname.startsWith("/conversations/");

  async function signOut() {
    await fetch(`${data?.config.authPath ?? "/api/auth"}/sign-out`, {
      credentials: "same-origin",
      method: "POST",
    });
    window.location.assign(data?.config.basePath ?? "/");
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "relative whitespace-nowrap px-1 py-2 font-mono text-[0.68rem] font-medium uppercase tracking-[0.12em] no-underline transition-colors after:absolute after:inset-x-0 after:-bottom-[1.05rem] after:h-px after:transition-colors",
      isActive
        ? "text-white after:bg-cyan-400"
        : "text-white/35 after:bg-transparent hover:text-white/70 hover:after:bg-white/20",
    );

  return (
    <main
      className={cn(
        "relative grid font-mono text-white",
        workspace
          ? "h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
          : "min-h-screen grid-rows-[auto_1fr]",
      )}
      style={dashboardBackground}
    >
      <header className="sticky top-0 z-10 border-b border-white/[0.05] bg-[#050507]/95">
        <div
          className={cn(
            dashboardContainerClass,
            "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-3 px-4 py-4",
            loggedIn
              ? "md:grid-cols-[auto_minmax(0,1fr)_auto]"
              : "md:grid-cols-[auto_minmax(0,1fr)]",
            workspace ? "md:px-4" : "md:px-8",
          )}
        >
          <Link
            className="flex min-w-0 max-w-full items-center gap-3 justify-self-start text-inherit no-underline"
            to="/"
          >
            <JuniorLogo />
            <div className="min-w-0 border-l border-white/10 pl-3">
              <h1 className="m-0 font-display text-xl font-medium leading-none tracking-[-0.03em]">
                Junior
              </h1>
            </div>
          </Link>
          <nav className="col-span-2 row-start-2 flex min-w-0 items-center gap-6 overflow-x-auto md:col-span-1 md:col-start-2 md:row-start-1 md:justify-self-start md:overflow-visible">
            <NavLink className={navLinkClass} to="/locations">
              Locations
            </NavLink>
            <NavLink className={navLinkClass} to="/people">
              People
            </NavLink>
            <NavLink className={navLinkClass} to="/system">
              System
            </NavLink>
          </nav>
          {loggedIn ? (
            <div className="col-start-2 row-start-1 justify-self-end md:col-start-3">
              <ProfileMenu identity={data!.me} onSignOut={signOut} />
            </div>
          ) : null}
        </div>
      </header>

      <Routes>
        <Route
          element={
            loading ? (
              <LoadingView label="Loading locations" />
            ) : (
              <LocationsPage />
            )
          }
          path="/locations"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading location" />
            ) : (
              <LocationDetailPage />
            )
          }
          path="/locations/:locationId"
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
            loading ? <LoadingView label="Loading system" /> : <SystemRoute />
          }
          path="/system"
        />
        <Route
          element={
            loading ? <LoadingView label="Loading people" /> : <PeoplePage />
          }
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

function SystemRoute() {
  const query = useSystemData();
  if (!query.data && !query.error) {
    return <LoadingView label="Loading system" />;
  }
  return query.data ? (
    <SystemPage data={query.data} />
  ) : (
    <LoadingView label={query.error?.message ?? "System unavailable"} />
  );
}

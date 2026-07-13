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
import { ProfileMenu } from "./components/ProfileMenu";
import { setDashboardTimeZone } from "./format";
import { ConversationWorkspace } from "./pages/ConversationWorkspace";
import { LocationDetailPage, LocationsPage } from "./pages/LocationsPage";
import { PeoplePage, PersonProfilePage } from "./pages/PeoplePage";
import { SystemPage } from "./pages/SystemPage";
import { cn, dashboardContainerClass } from "./styles";

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
      "whitespace-nowrap border-b-4 px-0.5 pb-1.5 pt-2 text-[0.9rem] font-semibold leading-tight no-underline transition-colors",
      isActive
        ? "border-b-[#beaaff] text-white"
        : "border-b-transparent text-[#b8b8b8] hover:border-b-white/45 hover:text-white",
    );

  return (
    <main
      className={cn(
        "grid bg-black font-sans text-white",
        workspace
          ? "h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
          : "min-h-screen grid-rows-[auto_1fr]",
      )}
    >
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#050505]/95 backdrop-blur">
        <div
          className={cn(
            dashboardContainerClass,
            "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-4",
            loggedIn
              ? "md:grid-cols-[auto_minmax(0,1fr)_auto]"
              : "md:grid-cols-[auto_minmax(0,1fr)]",
            workspace ? "md:px-4" : "md:px-8",
          )}
        >
          <Link
            className="flex min-w-0 max-w-full justify-self-start text-inherit no-underline"
            to="/"
          >
            <div className="min-w-0">
              <h1 className="m-0 text-2xl font-bold leading-none tracking-normal">
                Junior
              </h1>
            </div>
          </Link>
          <nav className="col-span-2 row-start-2 flex min-w-0 items-center gap-5 overflow-x-auto md:col-span-1 md:col-start-2 md:row-start-1 md:justify-self-end md:overflow-visible">
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

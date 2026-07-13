import { Link, Navigate, NavLink, Route, Routes } from "react-router";

import {
  useConversationHistoryData,
  useDashboardCoreData,
  usePluginData,
} from "./api";
import { LoadingView } from "./components/LoadingView";
import { ProfileMenu } from "./components/ProfileMenu";
import { setDashboardTimeZone } from "./format";
import { ConversationWorkspace } from "./pages/ConversationWorkspace";
import { ConversationsPage } from "./pages/ConversationsPage";
import { PeoplePage, PersonProfilePage } from "./pages/PeoplePage";
import { PluginsPage } from "./pages/PluginsPage";
import { cn } from "./styles";

/** Render the dashboard SPA shell and route-level loading states. */
export function DashboardShell() {
  const query = useDashboardCoreData();
  const data = query.data;
  if (data) {
    setDashboardTimeZone(data.config.timeZone);
  }
  const loading = !data && !query.error;
  const loggedIn = Boolean(data?.config.authRequired && data.me.user.email);

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
    <main className="grid min-h-screen grid-rows-[auto_1fr] bg-black font-sans text-white">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[#050505]/95 backdrop-blur">
        <div className="mx-auto grid w-full max-w-screen-xl grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:px-8">
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
            <NavLink className={navLinkClass} to="/conversations">
              Conversations
            </NavLink>
            <NavLink className={navLinkClass} to="/people">
              People
            </NavLink>
            <NavLink className={navLinkClass} to="/plugins">
              Plugins
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
        <Route
          element={
            loading ? (
              <LoadingView label="Loading conversations" />
            ) : (
              <ConversationHistoryRoute />
            )
          }
          path="/conversations"
        />
        <Route
          element={
            loading ? <LoadingView label="Loading plugins" /> : <PluginsRoute />
          }
          path="/plugins"
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

function ConversationHistoryRoute() {
  const query = useConversationHistoryData();
  if (!query.data && !query.error) {
    return <LoadingView label="Loading conversations" />;
  }
  return query.data ? (
    <ConversationsPage data={query.data} />
  ) : (
    <LoadingView label={query.error?.message ?? "Conversations unavailable"} />
  );
}

function PluginsRoute() {
  const query = usePluginData();
  if (!query.data && !query.error) {
    return <LoadingView label="Loading plugins" />;
  }
  return query.data ? (
    <PluginsPage data={query.data} />
  ) : (
    <LoadingView label={query.error?.message ?? "Plugins unavailable"} />
  );
}

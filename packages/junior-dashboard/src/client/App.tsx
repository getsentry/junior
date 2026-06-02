import { LogOut } from "lucide-react";
import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useParams,
} from "react-router";

import { useDashboardData } from "./api";
import { Button } from "./components/Button";
import { LoadingView } from "./components/LoadingView";
import {
  conversationPath,
  setDashboardTimeZone,
  visualStatusForSession,
} from "./format";
import { CommandCenter } from "./pages/CommandCenter";
import { ConversationPage } from "./pages/ConversationPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { cn } from "./styles";

/** Render the dashboard SPA shell and route-level loading states. */
export function DashboardShell() {
  const query = useDashboardData();
  const data = query.data;
  if (data) {
    setDashboardTimeZone(data.config.timeZone);
  }
  const loading = !data && !query.error;
  const loggedIn = Boolean(data?.config.authRequired && data.me.user.email);
  const activeTurnCount =
    data?.sessions.sessions.filter(
      (session) => visualStatusForSession(session) === "active",
    ).length ?? 0;
  const headerSummary = query.error
    ? query.error.message
    : data
      ? `${data.plugins.length} plugins / ${data.skills.length} skills / ${activeTurnCount} active`
      : "loading command center";

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
      <header className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-white/10 bg-[#050505]/95 px-4 py-3 backdrop-blur md:px-8 max-md:grid-cols-1">
        <Link
          className="flex min-w-0 max-w-full justify-self-start text-inherit no-underline"
          to="/"
        >
          <div className="min-w-0">
            <h1 className="m-0 text-2xl font-bold leading-none tracking-normal">
              Junior
            </h1>
            <div className="mt-1 truncate text-[0.82rem] leading-tight text-[#888]">
              {headerSummary}
            </div>
          </div>
        </Link>
        <div className="flex min-w-0 items-center gap-2 max-md:flex-wrap max-md:justify-between">
          <nav className="flex min-w-0 items-center gap-5">
            <NavLink className={navLinkClass} end to="/">
              Command
            </NavLink>
            <NavLink className={navLinkClass} to="/conversations">
              Conversations
            </NavLink>
          </nav>
          {loggedIn ? (
            <Button
              aria-label="Log out"
              onClick={() => void signOut()}
              size="icon"
              title="Log out"
            >
              <LogOut aria-hidden="true" size={16} strokeWidth={2} />
            </Button>
          ) : null}
        </div>
      </header>

      <Routes>
        <Route
          element={
            loading ? (
              <LoadingView label="Loading command center" />
            ) : (
              <CommandCenter data={data} queryError={query.error} />
            )
          }
          path="/"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading conversations" />
            ) : (
              <ConversationsPage data={data} />
            )
          }
          path="/conversations"
        />
        <Route
          element={
            loading ? (
              <LoadingView label="Loading conversation" />
            ) : (
              <ConversationPage data={data} />
            )
          }
          path="/conversations/:conversationId"
        />
        <Route
          element={<Navigate replace to="/conversations" />}
          path="/sessions"
        />
        <Route
          element={<LegacyConversationRedirect />}
          path="/sessions/:conversationId"
        />
        <Route element={<Navigate replace to="/" />} path="*" />
      </Routes>
    </main>
  );
}

function LegacyConversationRedirect() {
  const routeParams = useParams();
  const conversationId = routeParams.conversationId
    ? decodeURIComponent(routeParams.conversationId)
    : "";
  return <Navigate replace to={conversationPath(conversationId)} />;
}

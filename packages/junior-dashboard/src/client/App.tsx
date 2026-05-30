import {
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useParams,
} from "react-router";

import { useDashboardData } from "./api";
import { LoadingView } from "./components";
import {
  conversationPath,
  setDashboardTimeZone,
  visualStatusForSession,
} from "./format";
import { CommandCenter } from "./pages/CommandCenter";
import { ConversationPage } from "./pages/ConversationPage";
import { ConversationsPage } from "./pages/ConversationsPage";

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
    await fetch("/api/auth/sign-out", {
      credentials: "same-origin",
      method: "POST",
    });
    window.location.assign("/");
  }

  return (
    <main className="deck">
      <header className="topbar">
        <Link className="brand brand-link" to="/">
          <div className="mark">Jr</div>
          <div className="title">
            <h1>Junior</h1>
            <div className="subtitle">{headerSummary}</div>
          </div>
        </Link>
        <div className="top-actions">
          <nav className="nav">
            <NavLink className="nav-link" end to="/">
              Command
            </NavLink>
            <NavLink className="nav-link" to="/conversations">
              Conversations
            </NavLink>
          </nav>
          {loggedIn ? (
            <button
              aria-label="Log out"
              className="icon-button"
              type="button"
              title="Log out"
              onClick={() => void signOut()}
            >
              <svg
                aria-hidden="true"
                fill="none"
                height="16"
                viewBox="0 0 24 24"
                width="16"
              >
                <path
                  d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
                <path
                  d="m16 17 5-5-5-5"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
                <path
                  d="M21 12H9"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            </button>
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

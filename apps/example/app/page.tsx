export default function HomePage() {
  return (
    <main style={{ padding: 24, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      <h1>junior example app</h1>
      <p>
        Generic API route: <code>/api/[...path]</code>
      </p>
      <p>
        Routed endpoints include <code>/api/webhooks/[platform]</code>, <code>/api/oauth/callback/[provider]</code>, <code>/api/queue/callback</code>, and <code>/api/health</code>.
      </p>
      <p>
        Try slash skills:
        {" "}
        <code>/example-local</code>,
        {" "}
        <code>/example-bundle-help</code>,
        {" "}
        <code>/agent-browser</code>,
        {" "}
        <code>/github</code>,
        {" "}
        <code>/sentry</code>
      </p>
    </main>
  );
}

export default function HomePage() {
  return (
    <main style={{ padding: 24, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      <h1>junior example app</h1>
      <p>
        Slack webhook endpoint: <code>/api/webhooks/slack</code>
      </p>
      <p>
        OAuth callback endpoint: <code>/api/oauth/callback/[provider]</code>
      </p>
      <p>
        Queue callback endpoint: <code>/api/queue/callback</code>
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

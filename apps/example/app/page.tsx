export default function HomePage() {
  return (
    <main style={{ padding: 24, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      <h1>junior example</h1>
      <p>
        Webhook endpoint: <code>/api/webhooks/slack</code>
      </p>
      <p>
        Try slash skills: <code>/example-local</code> and <code>/example-bundle-help</code>
      </p>
    </main>
  );
}

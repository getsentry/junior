/** Shared redacted placeholder used by message and resource transcript rows. */
export function RedactedMarker() {
  return (
    <code className="inline-flex w-fit font-mono text-sm leading-tight text-dashboard-text-muted">
      {"<redacted>"}
    </code>
  );
}

/**
 * Split a search query into the terms that memory search matches. Keep this
 * in step with `searchTerms` in `@sentry/junior-memory` `src/viewer.ts`.
 */
function memorySearchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_'-]+/)
        .filter((term) => term.length >= 2),
    ),
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render memory text with each matched search term marked. */
export function MemorySearchHighlight(props: { query: string; text: string }) {
  const terms = memorySearchTerms(props.query);
  if (terms.length === 0) return <>{props.text}</>;
  // Longer terms first so a term that contains another term wins the match.
  const pattern = new RegExp(
    `(${terms
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|")})`,
    "gi",
  );
  // `split` with one capture group puts the matches at odd indexes.
  return (
    <>
      {props.text.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          <mark
            className="rounded-sm bg-amber-300/25 text-dashboard-text"
            key={index}
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

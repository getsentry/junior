/** List an Event trigger's filters. Every filter must match. */
export function TriggerFilters(props: { filters: readonly string[] }) {
  if (props.filters.length === 0) {
    return (
      <p className="m-0 mt-1 text-xs text-dashboard-text-muted">
        No filters. Runs on every selected event.
      </p>
    );
  }
  return (
    <div className="mt-1 text-xs text-dashboard-text-muted">
      <p className="m-0">Every filter must match:</p>
      <ul className="m-0 list-disc pl-5">
        {props.filters.map((filter) => (
          <li className="break-words" key={filter}>
            {filter}
          </li>
        ))}
      </ul>
    </div>
  );
}

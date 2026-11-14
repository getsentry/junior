/** Show one period total inside a chart card, above its chart. */
export function StatTile(props: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-md border border-dashboard-border-subtle bg-dashboard-overlay-soft px-3 py-3">
      <div className="font-display text-xl font-light text-dashboard-text">
        <span className={props.valueClassName}>{props.value}</span>
      </div>
      <div className="mt-1 font-sans text-xs leading-relaxed text-dashboard-text-muted">
        {props.label}
      </div>
    </div>
  );
}

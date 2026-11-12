/** Show `label` with the matched characters emphasized. */
export function MatchedLabel(props: { label: string; matches?: number[] }) {
  const { label, matches } = props;
  if (!matches?.length) return <>{label}</>;
  const matched = new Set(matches);
  const runs: { chars: string; matched: boolean }[] = [];
  for (let index = 0; index < label.length; index += 1) {
    const isMatched = matched.has(index);
    const last = runs.at(-1);
    if (last?.matched === isMatched) last.chars += label[index];
    else runs.push({ chars: label[index]!, matched: isMatched });
  }
  return runs.map((run, index) =>
    run.matched ? (
      <span className="font-semibold text-dashboard-accent-text" key={index}>
        {run.chars}
      </span>
    ) : (
      run.chars
    ),
  );
}

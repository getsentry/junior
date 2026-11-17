import { useState } from "react";

import type { SkillReport } from "@sentry/junior/api/schema";
import { useSkillsData } from "../api";
import { MatchedLabel } from "../components/MatchedLabel";
import { searchSkills, type SkillSearchRow } from "../components/skillSearch";
import { Badge } from "../components/ui/badge";
import { ComposerMenu, type ComposerTypeahead } from "./ComposerMenu";

/** Suggest skills while the reader types `$`. A row inserts `$skill-name`. */
export function ComposerSkillMenu(props: { typeahead: ComposerTypeahead }) {
  const { query } = props.typeahead;
  // Fetch the skill list on the first `$`, not on every composer mount.
  const [wanted, setWanted] = useState(false);
  if (query !== undefined && !wanted) setWanted(true);
  const skills = useSkillsData({ enabled: wanted }).data;
  const rows = query !== undefined && skills ? skillRows(skills, query) : [];
  return (
    <ComposerMenu
      label="Skills"
      onSelect={(row) => props.typeahead.insert({ text: `$${row.skill.name}` })}
      rowKey={(row) => row.skill.name}
      rows={rows}
      typeahead={props.typeahead}
    >
      {(row) => <SkillOption row={row} />}
    </ComposerMenu>
  );
}

function skillRows(
  skills: readonly SkillReport[],
  query: string,
): SkillSearchRow[] {
  // People type names after `$`, so a description match is noise here.
  if (query) {
    return searchSkills(skills, query).filter((row) => row.nameMatches);
  }
  return [...skills]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((skill) => ({ skill }));
}

function SkillOption(props: { row: SkillSearchRow }) {
  const { skill } = props.row;
  return (
    <span className="flex min-w-0 items-baseline gap-3">
      <span className="shrink-0 font-mono">
        $
        <MatchedLabel label={skill.name} matches={props.row.nameMatches} />
      </span>
      {skill.disableModelInvocation ? (
        <Badge
          className="shrink-0 py-0.5 leading-none font-medium"
          variant="accent"
        >
          Manual only
        </Badge>
      ) : null}
      <span className="min-w-0 truncate text-xs text-dashboard-text-muted">
        {skill.description}
      </span>
    </span>
  );
}

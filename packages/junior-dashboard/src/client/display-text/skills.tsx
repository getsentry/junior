import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useSkillsData } from "../api";
import { SkillLink } from "../components/SkillLink";
import { findSkillReferences } from "../conversations/skillReferences";
import { HighlightText } from "../conversations/transcriptSearch";

const InstalledSkills = createContext<ReadonlySet<string> | undefined>(
  undefined,
);

/**
 * Link each `$skill-name` of an installed skill in the text below. It loads
 * the skill list only when `text` has a reference, so most messages cost no
 * request.
 */
export function SkillReferencesProvider(props: {
  children: ReactNode;
  text: string;
}) {
  const referenced = useMemo(
    () => findSkillReferences(props.text).length > 0,
    [props.text],
  );
  const skills = useSkillsData({ enabled: referenced }).data;
  const names = useMemo(
    () => (skills ? new Set(skills.map((skill) => skill.name)) : undefined),
    [skills],
  );
  return (
    <InstalledSkills.Provider value={names}>
      {props.children}
    </InstalledSkills.Provider>
  );
}

/**
 * Render one text run with search matches highlighted. Under a
 * `SkillReferencesProvider`, each `$name` of an installed skill is a
 * `SkillLink`. Other names stay text.
 */
export function SkillReferenceText(props: { text: string }) {
  const skills = useContext(InstalledSkills);
  const references = skills
    ? findSkillReferences(props.text).filter((ref) => skills.has(ref.name))
    : [];
  if (!references.length) return <HighlightText text={props.text} />;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const ref of references) {
    if (ref.start > cursor) {
      nodes.push(
        <HighlightText
          key={`t${cursor}`}
          text={props.text.slice(cursor, ref.start)}
        />,
      );
    }
    nodes.push(
      <SkillLink key={`s${ref.start}`} name={ref.name}>
        <span className="font-mono">
          <HighlightText text={props.text.slice(ref.start, ref.end)} />
        </span>
      </SkillLink>,
    );
    cursor = ref.end;
  }
  if (cursor < props.text.length) {
    nodes.push(
      <HighlightText key={`t${cursor}`} text={props.text.slice(cursor)} />,
    );
  }
  return <>{nodes}</>;
}

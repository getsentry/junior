import type { ReactNode } from "react";

import { anchorTitleId } from "../../components/layout/AnchorHeading";
import { SectionIntro } from "../../components/layout/SectionIntro";

/** One Settings section. Links reach it with `#anchor`. */
export function SettingsSection(props: {
  anchor: string;
  children: ReactNode;
  description: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-labelledby={anchorTitleId(props.anchor)}
      className="grid min-w-0 gap-5"
    >
      <SectionIntro
        anchor={props.anchor}
        description={props.description}
        title={props.title}
      />
      {props.children}
    </section>
  );
}

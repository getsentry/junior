import type { ReactNode } from "react";

import { AnchorHeading } from "../../components/layout/AnchorHeading";
import { Card } from "../../components/layout/Card";
import { cn } from "../../styles";

/** How a setting is framed: its own card, or a row in a group. */
export type SettingFrameKind = "card" | "row";

/**
 * Show one setting under a heading that people can link to. `card` puts the
 * setting in its own raised card. `row` makes it a plain row, for a group
 * that draws one line between its rows.
 */
export function SettingFrame(props: {
  anchor: string;
  children: ReactNode;
  className?: string;
  frame?: SettingFrameKind;
  title: string;
}) {
  if (props.frame === "row") {
    return (
      <div className={cn("py-5 first:pt-0 last:pb-0", props.className)}>
        <AnchorHeading
          anchor={props.anchor}
          className="m-0 text-base font-semibold"
          title={props.title}
        />
        {props.children}
      </div>
    );
  }
  return (
    <Card
      className={cn("mt-6 mb-0", props.className)}
      padding="md"
      variant="raised"
    >
      <AnchorHeading
        anchor={props.anchor}
        className="m-0 text-lg font-bold"
        title={props.title}
      />
      {props.children}
    </Card>
  );
}

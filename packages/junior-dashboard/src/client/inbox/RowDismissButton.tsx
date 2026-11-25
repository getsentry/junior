import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";

/**
 * Dismiss an Inbox row. It is quiet like the other actions of its bar, and
 * has no check mark, so it does not read as an answer or an approval. A
 * note says what else the dismiss changes, such as on GitHub, in its
 * tooltip, so the change is no surprise.
 */
export function RowDismissButton(props: {
  disabled?: boolean;
  /** The action bar's look by default (`ButtonLook`). */
  look?: ButtonLook;
  /** "Dismiss" by default. */
  label?: string;
  /** The accessible name, when the label alone does not say what it acts on. */
  name?: string;
  /** What else the dismiss changes, such as `Also unassigns you on GitHub.` */
  note?: string | undefined;
  onClick(): void;
}) {
  const label = props.label ?? "Dismiss";
  const button = (
    <Button
      aria-label={props.name}
      className={props.look && LOOK_CLASSES[props.look]}
      disabled={props.disabled}
      onClick={props.onClick}
      title={props.look === "icon" && !props.note ? label : undefined}
      variant="ghost"
    >
      <X aria-hidden="true" size={15} />
      <ButtonLabel look={props.look}>{label}</ButtonLabel>
    </Button>
  );
  if (!props.note) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent size="compact">
        {props.look === "icon" ? `${label}. ${props.note}` : props.note}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * How Snooze and Dismiss look outside the action bar. `quiet`, in a stack
 * header: smaller, and only the icon on a narrow screen. `narrow`, next to
 * a card's main action: as tall as it on a touch screen, and only the
 * icon on a narrow screen.
 * `icon`, as a row's quick action: only the icon, with its label as the
 * name and the tooltip. `tall`, next to a card's main action: as tall as
 * it on a touch screen, with its label, and narrower on a phone.
 */
export type ButtonLook = "icon" | "narrow" | "quiet" | "tall";

/** The box of a button with a `ButtonLook`. */
export const LOOK_CLASSES: Record<ButtonLook, string> = {
  icon: "size-7 p-0",
  narrow: "pointer-coarse:h-11 max-sm:aspect-square max-sm:px-0",
  quiet: "h-7 gap-1.5 px-2 max-sm:w-7 max-sm:px-0",
  tall: "pointer-coarse:h-11 max-sm:px-2",
};

/** A button's label, hidden as its look says but still its name. */
export function ButtonLabel(props: { children: ReactNode; look?: ButtonLook }) {
  if (!props.look || props.look === "tall") return props.children;
  return (
    <span className={props.look === "icon" ? "sr-only" : "max-sm:sr-only"}>
      {props.children}
    </span>
  );
}

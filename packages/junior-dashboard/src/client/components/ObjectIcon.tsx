import {
  objectIconPaths,
  objectPresentation,
  type ObjectType,
  type ObjectTone,
} from "@sentry/junior-plugin-api";
import { cn } from "../styles";

const tones = {
  neutral: "text-dashboard-text-muted",
  success: "text-emerald-500",
  danger: "text-rose-500",
  warning: "text-amber-500",
  info: "text-cyan-500",
  accent: "text-violet-400",
} satisfies Record<ObjectTone, string>;

/** Keep object identity visible at card, link, and compact badge sizes. */
export function ObjectIcon(props: {
  objectType: ObjectType;
  status?: string;
  facts?: { type: string };
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  const presentation = objectPresentation(props);
  const label = [presentation.label, props.status].filter(Boolean).join(": ");
  return (
    <svg
      aria-hidden={props.decorative ? true : undefined}
      aria-label={props.decorative ? undefined : label}
      role={props.decorative ? undefined : "img"}
      className={cn(
        "inline-block shrink-0 align-middle",
        tones[presentation.tone],
        props.className,
      )}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      {objectIconPaths[presentation.icon].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}

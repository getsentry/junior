/**
 * TEMPORARY design prototype. Not for merge.
 *
 * Shows three options for how an Automation run names the credentials it used.
 * Select with `?runAs=a|b|c&cred=creator|system`. The report has no credential
 * mode yet, so the mode and creator come from the URL and fixed mock values.
 */
import { KeyRound, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router";

import { ActorAvatar } from "../components/ActorAvatar";
import { cn } from "../styles";

export type RunAsOption = "a" | "b" | "c";
export type RunAsPrototype = {
  creator: { name: string };
  mode: "creator" | "system";
  option: RunAsOption;
};

/** Read the prototype toggle from the URL. */
export function useRunAsPrototype(): RunAsPrototype | undefined {
  const [params] = useSearchParams();
  const option = params.get("runAs");
  if (option !== "a" && option !== "b" && option !== "c") return undefined;
  return {
    creator: { name: "Morgan Lee" },
    mode: params.get("cred") === "system" ? "system" : "creator",
    option,
  };
}

/** Option A: an "acting as" item in the header meta line. */
export function RunAsHeaderChip(props: { runAs: RunAsPrototype }) {
  if (props.runAs.mode === "system") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-dashboard-text"
        title="This run used Junior's system credentials. No personal account was used."
      >
        <KeyRound
          aria-hidden="true"
          className="size-3.5 text-amber-300"
          strokeWidth={2}
        />
        Ran with system credentials
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 text-dashboard-text"
      title={`This run used ${props.runAs.creator.name}'s connected accounts.`}
    >
      <ActorAvatar name={props.runAs.creator.name} size="list" />
      Ran as {props.runAs.creator.name}
    </span>
  );
}

/** Option B: a credentials line inside the trigger row. */
export function RunAsTriggerLine(props: { runAs: RunAsPrototype }) {
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-dashboard-text-muted">
      <span>Credentials</span>
      {props.runAs.mode === "system" ? (
        <span className="inline-flex items-center gap-1 rounded-md border border-dashboard-border px-1.5 py-0.5 text-dashboard-text">
          <KeyRound
            aria-hidden="true"
            className="size-3 text-amber-300"
            strokeWidth={2}
          />
          System
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-md border border-dashboard-border py-0.5 pl-0.5 pr-1.5 text-dashboard-text">
          <ActorAvatar name={props.runAs.creator.name} size="list" />
          {props.runAs.creator.name}
          <span className="text-dashboard-text-muted">(creator)</span>
        </span>
      )}
    </div>
  );
}

/** Option C: the identity the run acted as, in the message avatar column. */
export function RunAsAuthorAvatar(props: { runAs: RunAsPrototype }) {
  if (props.runAs.mode === "system") {
    return (
      <span className="grid size-8 place-items-center rounded-lg border border-dashboard-border-emphasis bg-dashboard-fill-soft text-amber-300">
        <ShieldCheck aria-hidden="true" size={16} strokeWidth={2} />
      </span>
    );
  }
  return (
    <span className="relative inline-grid size-8 place-items-center">
      <span className="scale-[1.15]">
        <ActorAvatar name={props.runAs.creator.name} size="detail" />
      </span>
      <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full border border-dashboard-bg bg-dashboard-surface-raised text-amber-300">
        <KeyRound aria-hidden="true" size={9} strokeWidth={2.4} />
      </span>
    </span>
  );
}

/** Option C: author label and credential badge for the trigger row. */
export function RunAsAuthorHeading(props: { runAs: RunAsPrototype }) {
  const system = props.runAs.mode === "system";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="font-sans text-sm font-semibold text-dashboard-text">
        {system ? "Junior" : props.runAs.creator.name}
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs leading-none",
          system
            ? "border-amber-300/40 text-amber-200"
            : "border-dashboard-border text-dashboard-text-muted",
        )}
      >
        <KeyRound aria-hidden="true" size={10} strokeWidth={2.2} />
        {system ? "System credentials" : "Creator credentials"}
      </span>
    </span>
  );
}

// Generated from design/inbox-kinds/github-pull-request.yaml.
// Edit the table, then run `pnpm inbox-kinds:check --update`.

/** The facts that the `github.pull_request` source gives about one viewer of a `github:pull_request` item. */
export interface Inputs {
  state: "open" | "merged" | "closed";
  draft: boolean;
  auto_merge: boolean;
  review_pending: boolean;
  merge_state: "clean" | "conflict" | "blocked" | "unknown";
  review_outcome: "approved" | "changes_requested" | "none";
  viewer: {
    requester: boolean;
    requested: boolean;
    /**
     * Junior handled every comment of the viewer's change request, the
     * required checks pass, and Junior asks for their review again in this
     * read. The source applies the guards of `pr-review-again`: it asks only
     * while the viewer's latest review still requests changes, so a viewer
     * who approved since is not asked, and it drops the ask once the viewer
     * comments or reviews after it.
     */
    asked_again: boolean;
    requests_changes: boolean;
    replied: boolean;
    shown: "nothing" | "merge" | "review";
  };
}

/** A command that a choice or Dismiss sends. */
export type Command = "remove-reviewer";

/** The handler that runs each command. */
export type Commands = Record<Command, () => Promise<void>>;

/** The output for one viewer, with the ID of the rule that gave it. */
export type Outcome =
  | { kind: "nothing" }
  | { kind: "close"; rule: "pr-ended"; status: "done" }
  | { kind: "close"; rule: "pr-ended"; status: "dismissed" }
  | { kind: "ask"; rule: "pr-merge"; label: "Ready to merge" }
  | { kind: "keep"; rule: "pr-merge" }
  | { kind: "ask"; rule: "pr-merge-reviewer"; label: "Ready to merge" }
  | { kind: "ask"; rule: "pr-review-again"; label: "Review requested" }
  | {
      kind: "ask";
      rule: "pr-review";
      label: "Review requested";
      dismiss: "remove-reviewer";
    };

/** Return the output of the first rule that matches the inputs. */
export function decide(inputs: Inputs): Outcome {
  // `pr-ended` row 1
  if (inputs.state === "merged") {
    return { kind: "close", rule: "pr-ended", status: "done" };
  }
  // `pr-ended` row 2
  if (inputs.state === "closed") {
    return { kind: "close", rule: "pr-ended", status: "dismissed" };
  }
  // `pr-merge` row 1
  if (
    inputs.state === "open" &&
    !inputs.draft &&
    !inputs.auto_merge &&
    !inputs.review_pending &&
    inputs.merge_state === "clean" &&
    inputs.review_outcome !== "changes_requested" &&
    inputs.viewer.requester
  ) {
    return { kind: "ask", rule: "pr-merge", label: "Ready to merge" };
  }
  // `pr-merge` row 2
  if (
    inputs.state === "open" &&
    !inputs.draft &&
    !inputs.auto_merge &&
    !inputs.review_pending &&
    inputs.merge_state === "unknown" &&
    inputs.viewer.shown === "merge"
  ) {
    return { kind: "keep", rule: "pr-merge" };
  }
  // `pr-merge` row 3
  if (
    inputs.state === "open" &&
    !inputs.draft &&
    !inputs.auto_merge &&
    !inputs.review_pending &&
    inputs.merge_state === "unknown" &&
    !inputs.viewer.asked_again
  ) {
    return { kind: "keep", rule: "pr-merge" };
  }
  // `pr-merge-reviewer` row 1
  if (
    !inputs.draft &&
    !inputs.auto_merge &&
    inputs.merge_state === "clean" &&
    inputs.review_outcome === "approved" &&
    !inputs.viewer.requester &&
    inputs.viewer.requested
  ) {
    return { kind: "ask", rule: "pr-merge-reviewer", label: "Ready to merge" };
  }
  // `pr-review-again` row 1
  if (inputs.viewer.requester && inputs.viewer.asked_again) {
    return { kind: "ask", rule: "pr-review-again", label: "Review requested" };
  }
  // `pr-review` row 1
  if (!inputs.viewer.requester && inputs.viewer.requested) {
    return {
      kind: "ask",
      rule: "pr-review",
      label: "Review requested",
      dismiss: "remove-reviewer",
    };
  }
  // `pr-review` row 2
  if (inputs.viewer.requested && !inputs.viewer.requests_changes) {
    return {
      kind: "ask",
      rule: "pr-review",
      label: "Review requested",
      dismiss: "remove-reviewer",
    };
  }
  // `pr-review` row 3
  if (inputs.viewer.requested && !inputs.viewer.replied) {
    return {
      kind: "ask",
      rule: "pr-review",
      label: "Review requested",
      dismiss: "remove-reviewer",
    };
  }
  return { kind: "nothing" };
}

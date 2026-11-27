// Generated from the Inbox kind table packages/junior-github/src/webhooks/pull-request-kind.yaml.
// Edit the table, then run `pnpm inbox-kinds:check --update`.

/** The facts that the `github.pull_request` source gives about one viewer of a `github:pull_request` item. */
export interface Inputs {
  state: "open" | "merged" | "closed";
  draft: boolean;
  /**
   * A person turned on auto-merge, so GitHub merges it without them.
   */
  auto_merge: boolean;
  /**
   * A person added it to the merge queue, so GitHub merges it.
   */
  in_merge_queue: boolean;
  /**
   * The base branch is the head branch of another open pull request, so
   * this one can merge only after that one. GitHub's merge state checks it
   * only against the base branch. A pull request from the default branch,
   * such as a sync into a long-lived branch, does not count.
   */
  base_open: boolean;
  /**
   * GitHub still requests a review from a person or a team.
   */
  review_pending: boolean;
  /**
   * `clean` when GitHub reports that it can merge, `conflict` with a merge
   * conflict, `blocked` when GitHub blocks the merge, and `unknown` while
   * GitHub still computes it.
   */
  merge_state: "clean" | "conflict" | "blocked" | "unknown";
  /**
   * `approved` with at least one approval and no reviewer who still
   * requests changes, `changes_requested` while a reviewer requests
   * changes, and `none` with neither.
   */
  review_outcome: "approved" | "changes_requested" | "none";
  viewer: {
    requester: boolean;
    /**
     * GitHub lets the viewer merge on the repository. Without it, a person
     * with write access merges, so the viewer gets no merge ask.
     */
    merge_access: boolean;
    /**
     * GitHub still requests the viewer's review. GitHub requests a review
     * only while it is pending, so `requested` is never true while
     * `review_pending` is false.
     */
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
    /**
     * The viewer's latest review waits for Junior's answer: it requests
     * changes, or it is a comment-only review, which Junior handles like a
     * change request. After the viewer approves, or after their review is
     * dismissed, only a comment-only review after a later ask counts. The
     * source gives false for a draft, because a draft cannot merge.
     */
    feedback: boolean;
    /**
     * The viewer's latest review that approves or requests changes approves
     * it. The source reads it for drafts too.
     */
    approved: boolean;
    /**
     * The viewer commented or reviewed after GitHub last asked them.
     */
    replied: boolean;
    /**
     * The output that the viewer has now.
     */
    shown: "nothing" | "merge" | "review" | "review_draft" | "mark_ready";
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
  | {
      kind: "ask";
      rule: "pr-review-again";
      label: "Review requested";
      step: "to review it, then mark it ready for review";
    }
  | { kind: "ask"; rule: "pr-review-again"; label: "Review requested" }
  | {
      kind: "ask";
      rule: "pr-review";
      label: "Review requested";
      step: "to review it, then mark it ready for review";
      dismiss: "remove-reviewer";
    }
  | {
      kind: "ask";
      rule: "pr-review";
      label: "Review requested";
      dismiss: "remove-reviewer";
    }
  | {
      kind: "ask";
      rule: "pr-mark-ready";
      label: "Review requested";
      step: "to mark it ready for review";
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
    !inputs.in_merge_queue &&
    !inputs.base_open &&
    !inputs.review_pending &&
    inputs.merge_state === "clean" &&
    inputs.review_outcome !== "changes_requested" &&
    inputs.viewer.requester &&
    inputs.viewer.merge_access &&
    !inputs.viewer.feedback
  ) {
    return { kind: "ask", rule: "pr-merge", label: "Ready to merge" };
  }
  // `pr-merge` row 2
  if (
    inputs.state === "open" &&
    !inputs.draft &&
    !inputs.auto_merge &&
    !inputs.in_merge_queue &&
    !inputs.base_open &&
    !inputs.review_pending &&
    inputs.merge_state === "unknown" &&
    inputs.viewer.requester &&
    inputs.viewer.merge_access &&
    !inputs.viewer.feedback &&
    inputs.viewer.shown === "merge"
  ) {
    return { kind: "keep", rule: "pr-merge" };
  }
  // `pr-merge` row 3
  if (
    inputs.state === "open" &&
    !inputs.draft &&
    !inputs.auto_merge &&
    !inputs.in_merge_queue &&
    !inputs.base_open &&
    !inputs.review_pending &&
    inputs.merge_state === "unknown" &&
    inputs.viewer.requester &&
    inputs.viewer.merge_access &&
    !inputs.viewer.asked_again &&
    !inputs.viewer.feedback
  ) {
    return { kind: "keep", rule: "pr-merge" };
  }
  // `pr-merge-reviewer` row 1
  if (
    !inputs.draft &&
    !inputs.auto_merge &&
    !inputs.in_merge_queue &&
    !inputs.base_open &&
    inputs.merge_state === "clean" &&
    inputs.review_outcome === "approved" &&
    !inputs.viewer.requester &&
    inputs.viewer.merge_access &&
    inputs.viewer.requested
  ) {
    return { kind: "ask", rule: "pr-merge-reviewer", label: "Ready to merge" };
  }
  // `pr-review-again` row 1
  if (inputs.draft && inputs.viewer.requester && inputs.viewer.asked_again) {
    return {
      kind: "ask",
      rule: "pr-review-again",
      label: "Review requested",
      step: "to review it, then mark it ready for review",
    };
  }
  // `pr-review-again` row 2
  if (inputs.viewer.requester && inputs.viewer.asked_again) {
    return { kind: "ask", rule: "pr-review-again", label: "Review requested" };
  }
  // `pr-review` row 1
  if (inputs.draft && inputs.viewer.requested) {
    return {
      kind: "ask",
      rule: "pr-review",
      label: "Review requested",
      step: "to review it, then mark it ready for review",
      dismiss: "remove-reviewer",
    };
  }
  // `pr-review` row 2
  if (!inputs.viewer.requester && inputs.viewer.requested) {
    return {
      kind: "ask",
      rule: "pr-review",
      label: "Review requested",
      dismiss: "remove-reviewer",
    };
  }
  // `pr-review` row 3
  if (inputs.viewer.requested && !inputs.viewer.feedback) {
    return {
      kind: "ask",
      rule: "pr-review",
      label: "Review requested",
      dismiss: "remove-reviewer",
    };
  }
  // `pr-review` row 4
  if (inputs.viewer.requested && !inputs.viewer.replied) {
    return {
      kind: "ask",
      rule: "pr-review",
      label: "Review requested",
      dismiss: "remove-reviewer",
    };
  }
  // `pr-mark-ready` row 1
  if (inputs.draft && inputs.viewer.requester && inputs.viewer.approved) {
    return {
      kind: "ask",
      rule: "pr-mark-ready",
      label: "Review requested",
      step: "to mark it ready for review",
    };
  }
  return { kind: "nothing" };
}

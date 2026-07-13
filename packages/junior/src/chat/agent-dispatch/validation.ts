import {
  dispatchOptionsSchema,
  isSlackDestination,
} from "@sentry/junior-plugin-api";
import type { BoundDispatchOptions, SlackDispatchOptions } from "./types";
import {
  verifyScheduledTaskCredentialSubject,
  verifySlackDirectCredentialSubject,
} from "@/chat/credentials/subject";
import { isDmChannel } from "@/chat/slack/client";

function hasIssueAtPath(
  issues: Array<{ code: string; path: PropertyKey[]; message: string }>,
  path: PropertyKey[],
): boolean {
  return issues.some(
    (issue) =>
      issue.path.length === path.length &&
      issue.path.every((value, index) => value === path[index]),
  );
}

function hasIssueUnderPath(
  issues: Array<{ code: string; path: PropertyKey[]; message: string }>,
  path: PropertyKey[],
): boolean {
  return issues.some((issue) =>
    path.every((value, index) => issue.path[index] === value),
  );
}

function dispatchOptionsErrorMessage(
  issues: Array<{ code: string; path: PropertyKey[]; message: string }>,
): string {
  if (hasIssueAtPath(issues, [])) {
    const unknownKeys = issues.some(
      (issue) => issue.code === "unrecognized_keys",
    );
    return unknownKeys
      ? "Dispatch options must not include unknown fields"
      : "Dispatch options are required";
  }
  if (
    issues.some(
      (issue) =>
        issue.code === "unrecognized_keys" && issue.path[0] === "destination",
    )
  ) {
    return "Dispatch destination must not include unknown fields";
  }
  if (
    issues.some(
      (issue) =>
        issue.code === "unrecognized_keys" &&
        issue.path[0] === "credentialSubject",
    )
  ) {
    return "Dispatch credentialSubject binding is runtime-owned";
  }
  if (hasIssueAtPath(issues, ["destination"])) {
    return "Dispatch destination platform must be slack";
  }
  if (hasIssueUnderPath(issues, ["destination", "teamId"])) {
    return "Dispatch destination teamId must be a Slack team id";
  }
  if (hasIssueUnderPath(issues, ["destination", "channelId"])) {
    return "Dispatch destination channelId must be a Slack channel id";
  }
  if (
    issues.some(
      (issue) =>
        issue.code === "unrecognized_keys" && issue.path[0] === "source",
    )
  ) {
    return "Dispatch source must not include unknown fields";
  }
  if (hasIssueAtPath(issues, ["source"])) {
    return "Dispatch source platform is required";
  }
  if (hasIssueUnderPath(issues, ["source", "teamId"])) {
    return "Dispatch source teamId must be a Slack team id";
  }
  if (hasIssueUnderPath(issues, ["source", "channelId"])) {
    return "Dispatch source channelId must be a Slack channel id";
  }
  if (hasIssueUnderPath(issues, ["source", "conversationId"])) {
    return "Dispatch source conversationId must be a local conversation id";
  }
  if (hasIssueUnderPath(issues, ["idempotencyKey"])) {
    const tooLong = issues.some(
      (issue) => issue.path[0] === "idempotencyKey" && issue.code === "too_big",
    );
    return tooLong
      ? "Dispatch idempotencyKey exceeds the maximum length"
      : "Dispatch idempotencyKey is required";
  }
  if (hasIssueUnderPath(issues, ["input"])) {
    const tooLong = issues.some(
      (issue) => issue.path[0] === "input" && issue.code === "too_big",
    );
    return tooLong
      ? "Dispatch input exceeds the maximum length"
      : "Dispatch input is required";
  }
  if (hasIssueUnderPath(issues, ["credentialSubject", "userId"])) {
    return "Dispatch credentialSubject userId is required";
  }
  if (hasIssueUnderPath(issues, ["credentialSubject", "allowedWhen"])) {
    return "Dispatch credentialSubject allowedWhen is invalid";
  }
  if (hasIssueUnderPath(issues, ["credentialSubject"])) {
    return "Dispatch credentialSubject type must be user";
  }
  const metadataIssue = issues.find(
    (issue) =>
      issue.path[0] === "metadata" &&
      (issue.message === "Dispatch metadata has too many keys" ||
        issue.message ===
          "Dispatch metadata keys must be single-line strings" ||
        issue.message ===
          "Dispatch metadata values must be single-line strings" ||
        issue.message === "Dispatch metadata key exceeds the maximum length" ||
        issue.message === "Dispatch metadata value exceeds the maximum length"),
  );
  if (metadataIssue) {
    return metadataIssue.message;
  }
  if (hasIssueUnderPath(issues, ["metadata"])) {
    return "Dispatch metadata values must be strings";
  }
  return "Dispatch options are invalid";
}

/** Validate plugin-provided dispatch options before core persists them. */
export function validateDispatchOptions(
  options: unknown,
): asserts options is SlackDispatchOptions {
  const parsed = dispatchOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error(dispatchOptionsErrorMessage(parsed.error.issues));
  }
  const candidate = parsed.data;
  const { credentialSubject, destination } = candidate;
  if (!isSlackDestination(destination)) {
    throw new Error("Dispatch destination platform must be slack");
  }
  if (credentialSubject !== undefined) {
    if (
      credentialSubject.allowedWhen === "private-direct-conversation" &&
      !isDmChannel(destination.channelId)
    ) {
      throw new Error(
        "Dispatch credentialSubject requires a private direct Slack destination",
      );
    }
  }
}

/** Verify runtime-owned access requirements for delegated dispatch credentials. */
export async function verifyDispatchCredentialSubjectAccess(
  options: BoundDispatchOptions,
  plugin: string,
): Promise<void> {
  if (!options.credentialSubject) {
    return;
  }

  const verified =
    options.credentialSubject.allowedWhen === "scheduled-task"
      ? verifyScheduledTaskCredentialSubject({
          plugin,
          subject: options.credentialSubject,
        })
      : verifySlackDirectCredentialSubject({
          channelId: options.destination.channelId,
          teamId: options.destination.teamId,
          subject: options.credentialSubject,
        });
  if (!verified) {
    throw new Error("Dispatch credentialSubject is not valid for this action");
  }
}

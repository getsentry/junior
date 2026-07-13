import { createHmac, timingSafeEqual } from "node:crypto";
import type { PluginCredentialSubject } from "@sentry/junior-plugin-api";
import type { CredentialSubject } from "@/chat/credentials/context";
import { isDmChannel, normalizeSlackConversationId } from "@/chat/slack/client";
import { isActorUserId, parseActorUserId } from "@/chat/actor";

const CREDENTIAL_SUBJECT_HMAC_CONTEXT = "junior.credential_subject.v1";
const CREDENTIAL_SUBJECT_SIGNATURE_VERSION = "v1";
type SlackDirectPluginCredentialSubject = Extract<
  PluginCredentialSubject,
  { allowedWhen: "private-direct-conversation" }
>;

function getCredentialSubjectSecret(): string | undefined {
  return process.env.JUNIOR_SECRET?.trim() || undefined;
}

/** Encode ordered signing fields without allowing delimiter ambiguity. */
function buildPayload(parts: string[]): string {
  return [CREDENTIAL_SUBJECT_HMAC_CONTEXT, ...parts].join("\0");
}

function signPayload(secret: string, payload: string): string {
  const digest = createHmac("sha256", secret).update(payload).digest("hex");
  return `${CREDENTIAL_SUBJECT_SIGNATURE_VERSION}=${digest}`;
}

function timingSafeMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/** Create a delegated user credential subject for a verified Slack DM turn. */
export function createSlackDirectCredentialSubject(input: {
  channelId: string | undefined;
  teamId: string | undefined;
  userId: string | undefined;
}): SlackDirectPluginCredentialSubject | undefined {
  const channelId = normalizeSlackConversationId(input.channelId);
  const teamId = input.teamId?.trim();
  const userId = parseActorUserId(input.userId);
  if (!channelId || !teamId || !userId || !isDmChannel(channelId)) {
    return undefined;
  }

  return {
    type: "user",
    userId,
    allowedWhen: "private-direct-conversation",
  };
}

/** Bind a delegated user subject to the Slack DM destination being dispatched. */
export function bindSlackDirectCredentialSubject(input: {
  channelId: string;
  subject: PluginCredentialSubject;
  teamId: string;
}): CredentialSubject | undefined {
  const channelId = normalizeSlackConversationId(input.channelId);
  const teamId = input.teamId.trim();
  const secret = getCredentialSubjectSecret();
  const { subject } = input;
  const userId = parseActorUserId(subject.userId);
  if (
    !channelId ||
    !teamId ||
    !secret ||
    !isDmChannel(channelId) ||
    subject.type !== "user" ||
    !userId ||
    subject.allowedWhen !== "private-direct-conversation"
  ) {
    return undefined;
  }

  return {
    type: "user",
    userId,
    allowedWhen: subject.allowedWhen,
    binding: {
      type: "slack-direct-conversation",
      teamId,
      channelId,
      signature: signPayload(
        secret,
        buildPayload([subject.allowedWhen, teamId, channelId, userId]),
      ),
    },
  };
}

/** Verify that a delegated subject was signed for the dispatch destination. */
export function verifySlackDirectCredentialSubject(input: {
  channelId: string;
  subject: CredentialSubject;
  teamId: string;
}): boolean {
  const channelId = normalizeSlackConversationId(input.channelId);
  const secret = getCredentialSubjectSecret();
  if (!channelId || !secret) {
    return false;
  }
  const { subject } = input;
  const binding = subject.binding;
  if (
    subject.type !== "user" ||
    !isActorUserId(subject.userId) ||
    subject.allowedWhen !== "private-direct-conversation" ||
    !binding ||
    binding.type !== "slack-direct-conversation" ||
    typeof binding.signature !== "string" ||
    !binding.signature ||
    binding.teamId !== input.teamId ||
    binding.channelId !== channelId
  ) {
    return false;
  }

  const expected = signPayload(
    secret,
    buildPayload([
      subject.allowedWhen,
      binding.teamId,
      binding.channelId,
      subject.userId,
    ]),
  );
  return timingSafeMatch(expected, binding.signature);
}

/** Bind a delegated user subject to one scheduler task dispatch. */
export function bindScheduledTaskCredentialSubject(input: {
  plugin: string;
  subject: PluginCredentialSubject;
}): CredentialSubject | undefined {
  const secret = getCredentialSubjectSecret();
  const plugin = input.plugin.trim();
  const userId = parseActorUserId(input.subject.userId);
  if (
    !secret ||
    plugin !== "scheduler" ||
    !userId ||
    input.subject.allowedWhen !== "scheduled-task"
  ) {
    return undefined;
  }
  const taskId = input.subject.taskId;
  if (!taskId || taskId !== taskId.trim()) {
    return undefined;
  }

  return {
    type: "user",
    userId,
    allowedWhen: "scheduled-task",
    taskId,
    binding: {
      type: "scheduled-task",
      plugin,
      taskId,
      signature: signPayload(
        secret,
        buildPayload(["scheduled-task", plugin, taskId, userId]),
      ),
    },
  };
}

/** Verify that a delegated subject was signed for one scheduler task. */
export function verifyScheduledTaskCredentialSubject(input: {
  plugin: string;
  subject: CredentialSubject;
}): boolean {
  const secret = getCredentialSubjectSecret();
  const { subject } = input;
  const binding = subject.binding;
  if (
    !secret ||
    input.plugin !== "scheduler" ||
    subject.type !== "user" ||
    !isActorUserId(subject.userId) ||
    subject.allowedWhen !== "scheduled-task" ||
    !subject.taskId ||
    binding.type !== "scheduled-task" ||
    binding.plugin !== input.plugin ||
    binding.taskId !== subject.taskId
  ) {
    return false;
  }

  const expected = signPayload(
    secret,
    buildPayload([
      "scheduled-task",
      binding.plugin,
      binding.taskId,
      subject.userId,
    ]),
  );
  return timingSafeMatch(expected, binding.signature);
}

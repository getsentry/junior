import type { AgentPluginCredentialSubject } from "@sentry/junior-plugin-api";
import { parseActorUserId } from "@/chat/services/requester-identity";

export interface CredentialSubjectBinding {
  type: "slack-direct-conversation";
  teamId: string;
  channelId: string;
  signature: string;
}

export type CredentialSystemActor = {
  type: "system";
  id: string;
};

export type CredentialSubject = AgentPluginCredentialSubject & {
  binding: CredentialSubjectBinding;
};

export type CredentialContext =
  | {
      actor: {
        type: "user";
        userId: string;
      };
      subject?: never;
    }
  | {
      actor: CredentialSystemActor;
      subject?: CredentialSubject;
    };

/** Return the user whose OAuth token may satisfy this credential request. */
export function credentialUserSubjectId(
  context: CredentialContext,
): string | undefined {
  if (context.actor.type === "user") {
    return context.actor.userId;
  }
  return context.subject?.userId;
}

/** Parse an untrusted credential context payload from sandbox egress state. */
export function parseCredentialContext(
  value: unknown,
): CredentialContext | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<CredentialContext>;
  const actor = parseActor(record.actor);
  if (!actor) {
    return undefined;
  }
  if (actor.type === "user") {
    if ("subject" in record && record.subject !== undefined) {
      return undefined;
    }
    return { actor };
  }
  if (!("subject" in record) || record.subject === undefined) {
    return { actor };
  }
  const subject = parseSubject(record.subject);
  if (!subject) {
    return undefined;
  }
  return {
    actor,
    subject,
  };
}

function parseActor(value: unknown): CredentialContext["actor"] | undefined {
  if (value && typeof value === "object") {
    const record = value as {
      id?: unknown;
      type?: unknown;
      userId?: unknown;
    };
    const userId = parseActorUserId(
      typeof record.userId === "string" ? record.userId : undefined,
    );
    if (record.type === "user" && userId) {
      return { type: "user", userId };
    }
    const systemId =
      typeof record.id === "string" &&
      record.id.length > 0 &&
      record.id === record.id.trim() &&
      record.id.toLowerCase() !== "unknown"
        ? record.id
        : undefined;
    if (record.type === "system" && systemId) {
      return { type: "system", id: systemId };
    }
  }
  return undefined;
}

function parseSubject(
  value: unknown,
): NonNullable<CredentialContext["subject"]> | undefined {
  if (value && typeof value === "object") {
    const record = value as Partial<NonNullable<CredentialContext["subject"]>>;
    const userId = parseActorUserId(
      typeof record.userId === "string" ? record.userId : undefined,
    );
    if (
      record.type === "user" &&
      userId &&
      record.allowedWhen === "private-direct-conversation"
    ) {
      if (!record.binding || typeof record.binding !== "object") {
        return undefined;
      }
      const binding = record.binding as Partial<CredentialSubjectBinding>;
      if (
        binding.type !== "slack-direct-conversation" ||
        typeof binding.teamId !== "string" ||
        !binding.teamId ||
        typeof binding.channelId !== "string" ||
        !binding.channelId ||
        typeof binding.signature !== "string" ||
        !binding.signature
      ) {
        return undefined;
      }
      return {
        type: "user",
        userId,
        allowedWhen: "private-direct-conversation",
        binding: {
          type: "slack-direct-conversation",
          teamId: binding.teamId,
          channelId: binding.channelId,
          signature: binding.signature,
        },
      };
    }
  }
  return undefined;
}

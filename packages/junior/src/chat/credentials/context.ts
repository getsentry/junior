export type CredentialSystemActor = {
  type: "system";
  id: string;
};

export type CredentialSubject = {
  type: "user";
  userId: string;
  allowedWhen: "private-direct-conversation";
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
    const record = value as Partial<CredentialContext["actor"]>;
    if (
      record.type === "user" &&
      typeof record.userId === "string" &&
      record.userId
    ) {
      return { type: "user", userId: record.userId };
    }
    if (
      record.type === "system" &&
      typeof record.id === "string" &&
      record.id
    ) {
      return { type: "system", id: record.id };
    }
  }
  return undefined;
}

function parseSubject(
  value: unknown,
): NonNullable<CredentialContext["subject"]> | undefined {
  if (value && typeof value === "object") {
    const record = value as Partial<NonNullable<CredentialContext["subject"]>>;
    if (
      record.type === "user" &&
      typeof record.userId === "string" &&
      record.userId &&
      record.allowedWhen === "private-direct-conversation"
    ) {
      return {
        type: "user",
        userId: record.userId,
        allowedWhen: "private-direct-conversation",
      };
    }
  }
  return undefined;
}

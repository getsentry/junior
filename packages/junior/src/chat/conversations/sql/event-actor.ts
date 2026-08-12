import { and, eq, or } from "drizzle-orm";
import { parseActorUserId } from "@/chat/actor";
import type { IdentityUpsert } from "@/chat/identities/identity";
import { upsertIdentity } from "@/chat/identities/sql";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import type { ConversationEventData } from "../history";

const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{5,}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readAuthor(meta: unknown): {
  email?: string;
  fullName?: string;
  isBot?: boolean;
  userId?: string;
  userName?: string;
} {
  if (!isRecord(meta) || !isRecord(meta.author)) {
    return {};
  }
  const author = meta.author;
  return {
    ...(typeof author.email === "string" ? { email: author.email } : {}),
    ...(typeof author.fullName === "string"
      ? { fullName: author.fullName }
      : {}),
    ...(typeof author.isBot === "boolean" ? { isBot: author.isBot } : {}),
    ...(typeof author.userId === "string" ? { userId: author.userId } : {}),
    ...(typeof author.userName === "string"
      ? { userName: author.userName }
      : {}),
  };
}

async function loadConversationSlackTenantId(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<string | undefined> {
  const [row] = await executor
    .db()
    .select({
      providerTenantId: juniorDestinations.providerTenantId,
      sessionSource: juniorConversations.sessionSource,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(eq(juniorConversations.conversationId, conversationId))
    .limit(1);
  const destinationTenant = row?.providerTenantId?.trim();
  if (destinationTenant) {
    return destinationTenant;
  }
  const sessionSource = row?.sessionSource;
  if (
    isRecord(sessionSource) &&
    sessionSource.platform === "slack" &&
    typeof sessionSource.teamId === "string" &&
    sessionSource.teamId.trim()
  ) {
    return sessionSource.teamId.trim();
  }
  return undefined;
}

async function findIdentityIdByProviderSubject(
  executor: JuniorSqlDatabase,
  args: {
    provider: string;
    providerSubjectId: string;
    providerTenantId?: string;
  },
): Promise<string | undefined> {
  const rows = await executor
    .db()
    .select({ id: juniorIdentities.id })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, args.provider),
        eq(juniorIdentities.providerSubjectId, args.providerSubjectId),
        args.providerTenantId === undefined
          ? undefined
          : eq(juniorIdentities.providerTenantId, args.providerTenantId),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

async function findJuniorIdentityIdByEmail(
  executor: JuniorSqlDatabase,
  email: string,
): Promise<string | undefined> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  const rows = await executor
    .db()
    .select({ id: juniorIdentities.id })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "junior"),
        eq(juniorIdentities.kind, "user"),
        or(
          eq(juniorIdentities.providerSubjectId, normalized),
          and(
            eq(juniorIdentities.emailNormalized, normalized),
            eq(juniorIdentities.emailVerified, true),
          ),
        ),
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

/**
 * Resolve the durable actor identity for one event payload.
 * Human user messages get an identity when author data is enough; other events
 * keep a null actor.
 */
export async function resolveEventActorIdentityId(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    data: ConversationEventData;
    nowMs: number;
  },
): Promise<string | undefined> {
  const data = args.data;
  if (data.type !== "message" && data.type !== "message_updated") {
    return undefined;
  }
  if (typeof data.authorIdentityId === "string" && data.authorIdentityId) {
    return data.authorIdentityId;
  }
  if (data.role !== "user") {
    return undefined;
  }

  const author = readAuthor(data.meta);
  if (author.isBot === true) {
    return undefined;
  }
  const userId = parseActorUserId(author.userId);
  if (!userId) {
    return undefined;
  }

  if (SLACK_USER_ID_PATTERN.test(userId)) {
    const tenantId = await loadConversationSlackTenantId(
      executor,
      args.conversationId,
    );
    const observation: IdentityUpsert = {
      kind: "user",
      provider: "slack",
      providerSubjectId: userId,
      ...(tenantId ? { providerTenantId: tenantId } : {}),
      ...(author.fullName ? { displayName: author.fullName } : {}),
      ...(author.userName ? { handle: author.userName } : {}),
      ...(author.email
        ? { email: author.email, emailVerified: true }
        : {}),
    };
    // Prefer an exact tenant match when known; otherwise create/update without
    // inventing a tenant for multi-workspace Slack subjects.
    if (tenantId) {
      const stored = await upsertIdentity(executor, observation, args.nowMs);
      return stored.id;
    }
    return (
      (await findIdentityIdByProviderSubject(executor, {
        provider: "slack",
        providerSubjectId: userId,
      })) ?? undefined
    );
  }

  const email =
    typeof author.email === "string" && author.email.includes("@")
      ? author.email.trim().toLowerCase()
      : userId.includes("@")
        ? userId.trim().toLowerCase()
        : undefined;
  if (email) {
    const stored = await upsertIdentity(
      executor,
      {
        kind: "user",
        provider: "junior",
        providerSubjectId: email,
        email,
        emailVerified: true,
        ...(author.fullName ? { displayName: author.fullName } : {}),
        metadata: { platform: "web" },
      },
      args.nowMs,
    );
    return stored.id;
  }

  // Dashboard authors store dashboard:<hash> without email in meta. Match an
  // existing junior identity when one was already linked for that subject.
  if (userId.startsWith("dashboard:")) {
    return findIdentityIdByProviderSubject(executor, {
      provider: "junior",
      providerSubjectId: userId,
    });
  }

  return findJuniorIdentityIdByEmail(executor, userId);
}

/** Drop payload-only authorIdentityId after lifting it onto the event column. */
export function stripPayloadAuthorIdentityId(
  data: ConversationEventData,
): ConversationEventData {
  if (
    (data.type !== "message" && data.type !== "message_updated") ||
    data.authorIdentityId === undefined
  ) {
    return data;
  }
  const { authorIdentityId: _authorIdentityId, ...rest } = data;
  return rest;
}

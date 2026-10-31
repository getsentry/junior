import { and, eq, inArray, or, sql } from "drizzle-orm";
import { isSlackUserId, parseActorUserId } from "@/chat/actor";
import { parseSessionSource } from "@/chat/source";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { logWarn } from "@/chat/logging";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
} from "@/db/schema";
import type { ConversationEventData } from "../history";

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
    ...(typeof author.email === "string" ? { email: author.email } : undefined),
    ...(typeof author.fullName === "string"
      ? { fullName: author.fullName }
      : undefined),
    ...(typeof author.isBot === "boolean"
      ? { isBot: author.isBot }
      : undefined),
    ...(typeof author.userId === "string"
      ? { userId: author.userId }
      : undefined),
    ...(typeof author.userName === "string"
      ? { userName: author.userName }
      : undefined),
  };
}

/** Read the Slack workspace that owns a conversation, when it has one. */
export async function loadConversationSlackTenantId(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<string | undefined> {
  return (await loadConversationSlackTenantIds(executor, [conversationId])).get(
    conversationId,
  );
}

/** Read the Slack workspace that owns each conversation, with one query. */
export async function loadConversationSlackTenantIds(
  executor: JuniorSqlDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await executor
    .db()
    .select({
      conversationId: juniorConversations.conversationId,
      providerTenantId: juniorDestinations.providerTenantId,
      sessionSource: juniorConversations.sessionSource,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(inArray(juniorConversations.conversationId, [...conversationIds]));
  const tenants = new Map<string, string>();
  for (const row of rows) {
    const sessionSource = parseSessionSource(row.sessionSource);
    const tenantId =
      row.providerTenantId?.trim() ||
      (sessionSource?.kind === "slack" ? sessionSource.teamId : undefined);
    if (tenantId) tenants.set(row.conversationId, tenantId);
  }
  return tenants;
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
 * Resolve a dashboard:<hash> author against junior identities keyed by email.
 * Web actors store userId as dashboard:${sha256(email).slice(0,24)} while the
 * durable identity subject remains the verified email.
 */
async function findJuniorIdentityIdByDashboardAuthorId(
  executor: JuniorSqlDatabase,
  dashboardAuthorId: string,
): Promise<string | undefined> {
  if (!dashboardAuthorId.startsWith("dashboard:")) {
    return undefined;
  }
  const rows = await executor
    .db()
    .select({ id: juniorIdentities.id })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "junior"),
        eq(juniorIdentities.kind, "user"),
        eq(juniorIdentities.emailVerified, true),
        sql`${juniorIdentities.emailNormalized} is not null`,
        // Match webActorFromEmail(): dashboard:${sha256(email).slice(0,24)}
        sql`concat(
          'dashboard:',
          left(encode(digest(${juniorIdentities.emailNormalized}, 'sha256'), 'hex'), 24)
        ) = ${dashboardAuthorId}`,
      ),
    )
    .limit(1);
  return rows[0]?.id;
}

/**
 * Resolve the durable actor identity for one event payload.
 * Ingress sets `authorIdentityId` on new user Messages. Legacy writes without
 * it still guess the author from its data, and a new Message logs the guess.
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
  if (data.type === "message") {
    // TODO(dcramer): Remove the guess after every ingress sets the author.
    logWarn("conversation.message.author_identity.missing", {
      "app.message.id": data.messageId,
    });
  }

  const author = readAuthor(data.meta);
  if (author.isBot === true) {
    return undefined;
  }
  const userId = parseActorUserId(author.userId);
  if (!userId) {
    return undefined;
  }

  if (isSlackUserId(userId)) {
    const tenantId = await loadConversationSlackTenantId(
      executor,
      args.conversationId,
    );
    // Prefer an exact tenant match when known; otherwise only find an existing
    // identity, so a multi-workspace Slack subject does not get a tenant.
    if (!tenantId) {
      return await findIdentityIdByProviderSubject(executor, {
        provider: "slack",
        providerSubjectId: userId,
      });
    }
    return await resolveActorIdentityId(
      executor,
      {
        platform: "slack",
        teamId: tenantId,
        userId,
        ...(author.email ? { email: author.email } : undefined),
        ...(author.fullName ? { fullName: author.fullName } : undefined),
        ...(author.userName ? { userName: author.userName } : undefined),
      },
      args.nowMs,
    );
  }

  const email =
    typeof author.email === "string" && author.email.includes("@")
      ? author.email
      : userId.includes("@")
        ? userId
        : undefined;
  if (email) {
    return await resolveActorIdentityId(
      executor,
      {
        platform: "web",
        userId,
        email,
        ...(author.fullName ? { fullName: author.fullName } : undefined),
      },
      args.nowMs,
    );
  }

  // Dashboard authors store dashboard:<hash> without email in meta. Junior
  // identities stay keyed by verified email, so match the hash of that email.
  if (userId.startsWith("dashboard:")) {
    return findJuniorIdentityIdByDashboardAuthorId(executor, userId);
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

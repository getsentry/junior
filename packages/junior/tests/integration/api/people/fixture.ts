import { createSqlStore } from "@/chat/conversations/sql/store";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { juniorConversations, juniorIdentities } from "@/db/schema";
import type { LocalJuniorSqlFixture } from "../../../fixtures/sql";

/** Seed representative verified and untrusted people rows for people API tests. */
export async function seedPeople(fixture: LocalJuniorSqlFixture) {
  const store = createSqlStore(fixture.sql);
  await migrateSchema(fixture.sql);

  await store.recordActivity({
    conversationId: "slack:C1:123",
    channelName: "proj-alpha",
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C1",
    },
    actor: {
      email: "Alice@Example.com",
      fullName: "Alice Example",
      platform: "slack",
      slackUserId: "U1",
      slackUserName: "alice",
      teamId: "T1",
    },
    source: "slack",
    visibility: "public",
    nowMs: Date.parse("2026-06-10T10:03:00.000Z"),
  });
  await store.recordExecution({
    conversationId: "slack:C1:123",
    createdAtMs: Date.parse("2026-06-10T10:03:00.000Z"),
    execution: {
      runId: "turn-1",
      status: "running",
      updatedAtMs: Date.parse("2026-06-10T10:04:00.000Z"),
    },
    lastActivityAtMs: Date.parse("2026-06-10T10:04:00.000Z"),
    metrics: { durationMs: 1_000, usage: { totalTokens: 100 } },
    source: "slack",
    updatedAtMs: Date.parse("2026-06-10T10:04:00.000Z"),
  });
  await store.recordActivity({
    actor: {
      email: "alice@example.com",
      fullName: "Provider Specific Alice",
      platform: "slack",
      slackUserId: "U1B",
      teamId: "T1",
    },
    channelName: "private-project",
    conversationId: "slack:C4:456",
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C4",
    },
    nowMs: Date.parse("2026-06-12T11:00:00.000Z"),
    source: "slack",
    title: "Private project plan",
  });
  await store.recordExecution({
    conversationId: "slack:C4:456",
    createdAtMs: Date.parse("2026-06-12T11:00:00.000Z"),
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C4",
    },
    execution: {
      runId: "turn-2",
      status: "failed",
      updatedAtMs: Date.parse("2026-06-12T11:01:00.000Z"),
    },
    lastActivityAtMs: Date.parse("2026-06-12T11:01:00.000Z"),
    metrics: { durationMs: 500, usage: { totalTokens: 50 } },
    actor: {
      email: "alice@example.com",
      fullName: "Provider Specific Alice",
      platform: "slack",
      slackUserId: "U1B",
      teamId: "T1",
    },
    source: "slack",
    updatedAtMs: Date.parse("2026-06-12T11:01:00.000Z"),
  });
  await store.recordActivity({
    conversationId: "slack:C2:789",
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C2",
    },
    actor: {
      email: "bob@example.com",
      fullName: "Bob Example",
      platform: "slack",
      slackUserId: "U2",
      teamId: "T1",
    },
    source: "slack",
    nowMs: Date.parse("2026-06-13T11:01:00.000Z"),
  });
  await store.recordActivity({
    conversationId: "slack:C1:999",
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C1",
    },
    actor: {
      email: "later@example.com",
      fullName: "Later Assignee",
      platform: "slack",
      slackUserId: "U9",
      teamId: "T1",
    },
    source: "slack",
    nowMs: Date.parse("2026-06-11T09:04:00.000Z"),
  });
  await store.recordActivity({
    conversationId: "slack:C3:000",
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C3",
    },
    actor: {
      fullName: "No Email",
      platform: "slack",
      slackUserId: "U3",
      teamId: "T1",
    },
    source: "slack",
    nowMs: Date.parse("2026-06-14T11:01:00.000Z"),
  });

  const now = new Date("2026-06-14T12:00:00.000Z");
  await fixture.sql.db().insert(juniorIdentities).values({
    id: "untrusted-identity",
    kind: "user",
    provider: "slack",
    providerTenantId: "T1",
    providerSubjectId: "U-untrusted",
    displayName: "Untrusted User",
    handle: "untrusted",
    email: "untrusted@example.com",
    emailNormalized: "untrusted@example.com",
    emailVerified: false,
    avatarUrl: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    userId: null,
  });
  await fixture.sql.db().insert(juniorConversations).values({
    conversationId: "slack:C5:untrusted",
    schemaVersion: 1,
    source: "slack",
    actorIdentityId: "untrusted-identity",
    createdAt: now,
    lastActivityAt: now,
    updatedAt: now,
    executionStatus: "idle",
  });
}

/** Seed an identity whose shared user name is filled by a later observation. */
export async function seedDisplayNameBackfill(fixture: LocalJuniorSqlFixture) {
  const store = createSqlStore(fixture.sql);

  await store.recordActivity({
    conversationId: "slack:C6:nameless-first",
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C6",
    },
    actor: {
      email: "nameless@example.com",
      platform: "slack",
      slackUserId: "U-nameless-1",
      teamId: "T1",
    },
    source: "slack",
    nowMs: Date.parse("2026-06-08T09:00:00.000Z"),
  });
  await store.recordActivity({
    conversationId: "slack:C6:nameless-later",
    destination: {
      platform: "slack",
      teamId: "T1",
      channelId: "C6",
    },
    actor: {
      email: "NameLess@Example.com",
      fullName: "Named Later",
      platform: "slack",
      slackUserId: "U-nameless-2",
      teamId: "T1",
    },
    source: "slack",
    nowMs: Date.parse("2026-06-14T09:00:00.000Z"),
  });
}

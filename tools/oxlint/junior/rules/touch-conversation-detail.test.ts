import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { touchConversationDetailRule } from "./touch-conversation-detail.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const missingTouch = [{ messageId: "missingTouch" }];

new RuleTester().run("touch-conversation-detail", touchConversationDetailRule, {
  valid: [
    `async function append(db) {
      await db.with(conversationDetailTouch(db, [id])).insert(juniorConversationEvents).values(rows);
    }`,
    `async function append(db) {
      await db.insert(juniorConversationEvents).values(rows);
      await touchConversationDetail(db, [id]);
    }`,
    `async function stop(db) {
      await db.update(juniorConversations).set({ stoppedAt, detailVersion: nextDetailVersion });
    }`,
    `async function create(db) {
      await db.insert(juniorConversations).values(row);
    }`,
    `async function ensure(db) {
      const insert = db.insert(juniorConversations).values(row);
      await insert.onConflictDoUpdate({ target, set: { updatedAt, detailVersion: nextDetailVersion } });
    }`,
    `async function read(db) {
      await db.select().from(juniorConversationEvents);
    }`,
    `async function other(db) {
      await db.insert(juniorUsers).values(row);
    }`,
  ],
  invalid: [
    {
      code: `async function append(db) {
        await db.with(otherCte).insert(juniorConversationEvents).values(rows);
      }`,
      errors: missingTouch,
    },
    {
      code: `async function append(db) {
        await db.insert(juniorConversationEvents).values(rows);
      }`,
      errors: missingTouch,
    },
    {
      code: `async function append(db) {
        await touchConversationDetail(db, [id]);
        await db.insert(juniorConversationEvents).values(rows);
      }`,
      errors: missingTouch,
    },
    {
      code: `async function append(db) {
        const write = async () => db.delete(juniorConversationAnnotations).where(match);
        await write();
        await touchConversationDetail(db, [id]);
      }`,
      errors: missingTouch,
    },
    {
      code: `async function rename(db) {
        await db.update(juniorConversations).set({ title });
      }`,
      errors: missingTouch,
    },
    {
      code: `async function ensure(db) {
        const insert = db.insert(juniorConversations).values(row);
        await insert.onConflictDoUpdate({ target, set: { updatedAt } });
      }`,
      errors: missingTouch,
    },
    {
      code: "async function raw(db) { await db.execute(sql`update ${juniorConversationBriefs} set x = 1`); }",
      errors: missingTouch,
    },
    {
      code: "async function raw(db) { await db.execute(sql`delete from junior_attachments where id = ${id}`); }",
      errors: missingTouch,
    },
  ],
});

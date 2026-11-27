import pg from "pg";
import { onTestFinished } from "vitest";
import { getSqlExecutor } from "@/chat/db";

/** How many rows `seedDashboardScale` adds, by kind. */
const SCALE = {
  /** Private root Conversations of other people. */
  roots: 3_000,
  /** People who own the seeded rows. The test viewer is none of them. */
  users: 40,
  /** Private Spaces of other people, each with its Lead. */
  spaces: 20,
  /** Top-level Threads of each Space, under its Lead. */
  spaceThreads: 25,
  /** Levels of the deep tree, below its root. */
  treeDepth: 60,
  /** Tasks under each level of the deep tree. */
  treeFanOut: 8,
  /** Inbox items of each kind that a Conversation owns. */
  itemsPerKind: 300,
  /** The first of each kind are open. The others are done. */
  openItemsPerKind: 75,
} as const;

const SEED_TIME = "timestamptz '2026-01-01T00:00:00Z'";

const SEEDED_TABLES = [
  "junior_users",
  "junior_conversations",
  "junior_conversation_participants",
  "junior_spaces",
  "junior_questions",
  "junior_todos",
  "junior_inbox_items",
  "junior_inbox_item_assignees",
  "junior_inbox_item_conversations",
  "test_plugin_inbox_owners",
];

/**
 * Remove the column statistics that `analyze` wrote. The shared setup
 * truncates the rows before the next test, but not their statistics, and
 * the plans of later tests would use them. It connects on its own, since
 * the test may have closed the product's database by now.
 */
async function forgetStatistics(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env["DATABASE_URL"],
  });
  await client.connect();
  try {
    await client.query(
      "delete from pg_statistic where starelid = any($1::regclass[])",
      [SEEDED_TABLES],
    );
  } finally {
    await client.end();
  }
}

/**
 * Add rows of other people that the viewer's dashboard reads must skip:
 * private roots, Spaces, a deep tree, and Inbox items of each kind that a
 * Conversation owns. Then `analyze`, so a plan that reads them in full or
 * once per list row costs more than one through an index. The shared setup
 * truncates every table before each test, so each test seeds its own rows.
 */
export async function seedDashboardScale(): Promise<void> {
  const db = getSqlExecutor();
  const scale = SCALE;
  onTestFinished(forgetStatistics);
  await db.transaction(async () => {
    await db.execute(
      `insert into junior_users
        (id, primary_email, primary_email_normalized, display_name,
         created_at, updated_at)
      select 'scale-user-' || n, 'scale-' || n || '@scale.test',
        'scale-' || n || '@scale.test', 'Scale ' || n, ${SEED_TIME}, ${SEED_TIME}
      from generate_series(1, $1) n`,
      [scale.users],
    );
    await db.execute(
      `insert into junior_conversations
        (conversation_id, root_conversation_id, kind, visibility, source,
         title, created_at, last_activity_at, last_message_at, updated_at,
         execution_status)
      select 'scale:root:' || n, 'scale:root:' || n, 'thread', 'private',
        'slack', 'Scale root ' || n, ${SEED_TIME} - n * interval '1 minute',
        ${SEED_TIME} - n * interval '1 minute',
        ${SEED_TIME} - n * interval '1 minute',
        ${SEED_TIME} - n * interval '1 minute', 'idle'
      from generate_series(1, $1) n`,
      [scale.roots],
    );
    await db.execute(
      `insert into junior_conversation_participants
        (user_id, root_conversation_id, last_message_at)
      select 'scale-user-' || (1 + n % $2), 'scale:root:' || n,
        ${SEED_TIME} - n * interval '1 minute'
      from generate_series(1, $1) n`,
      [scale.roots, scale.users],
    );

    // A chain of Threads under one root, with Tasks at each level.
    await db.execute(
      `insert into junior_conversations
        (conversation_id, root_conversation_id, parent_conversation_id, kind,
         visibility, created_at, last_activity_at, updated_at,
         execution_status)
      select 'scale:tree:' || n, 'scale:root:1',
        case when n = 1 then 'scale:root:1' else 'scale:tree:' || (n - 1) end,
        'thread', 'private', ${SEED_TIME}, ${SEED_TIME}, ${SEED_TIME}, 'idle'
      from generate_series(1, $1) n`,
      [scale.treeDepth],
    );
    await db.execute(
      `insert into junior_conversations
        (conversation_id, root_conversation_id, parent_conversation_id, kind,
         visibility, created_at, last_activity_at, updated_at,
         execution_status)
      select 'scale:tree:' || level || ':task:' || n, 'scale:root:1',
        'scale:tree:' || level, 'task', 'private', ${SEED_TIME}, ${SEED_TIME},
        ${SEED_TIME}, 'idle'
      from generate_series(1, $1) level, generate_series(1, $2) n`,
      [scale.treeDepth, scale.treeFanOut],
    );

    await db.execute(
      `insert into junior_spaces
        (id, visibility, created_by_user_id, created_at, updated_at)
      select 'scale-space-' || n, 'private', 'scale-user-' || (1 + n % $2),
        ${SEED_TIME}, ${SEED_TIME}
      from generate_series(1, $1) n`,
      [scale.spaces, scale.users],
    );
    await db.execute(
      `insert into junior_conversations
        (conversation_id, root_conversation_id, kind, space_id, visibility,
         title, created_at, last_activity_at, updated_at, execution_status)
      select 'scale:lead:' || n, 'scale:lead:' || n, 'lead',
        'scale-space-' || n, 'private', 'Scale Space ' || n, ${SEED_TIME},
        ${SEED_TIME}, ${SEED_TIME}, 'idle'
      from generate_series(1, $1) n`,
      [scale.spaces],
    );
    await db.execute(
      `insert into junior_conversation_participants
        (user_id, root_conversation_id, last_message_at)
      select 'scale-user-' || (1 + n % $2), 'scale:lead:' || n, ${SEED_TIME}
      from generate_series(1, $1) n`,
      [scale.spaces, scale.users],
    );
    await db.execute(
      `insert into junior_conversations
        (conversation_id, root_conversation_id, parent_conversation_id, kind,
         visibility, created_at, last_activity_at, updated_at,
         execution_status)
      select 'scale:lead:' || space || ':thread:' || n, 'scale:lead:' || space,
        'scale:lead:' || space, 'thread', 'private', ${SEED_TIME},
        ${SEED_TIME}, ${SEED_TIME}, 'idle'
      from generate_series(1, $1) space, generate_series(1, $2) n`,
      [scale.spaces, scale.spaceThreads],
    );

    // Items of each kind that a Conversation owns. A question has its row,
    // a reply names its Conversation, a To-do names its list's Conversation
    // and its id, and a test plugin item maps to its Conversation in the
    // plugin's owner table. A question item's content is its question's.
    await db.execute(
      `insert into junior_questions
        (id, conversation_id, title, body, created_at, updated_at)
      select 'scale-question-' || n, 'scale:root:' || n, 'Scale question',
        'Scale question', ${SEED_TIME}, ${SEED_TIME}
      from generate_series(1, $1) n`,
      [scale.itemsPerKind],
    );
    await db.execute(
      `insert into junior_todos
        (conversation_id, id, title, status, version, created_at, updated_at)
      select 'scale:root:' || n, 1, 'Scale To-do', 'open', 1, ${SEED_TIME},
        ${SEED_TIME}
      from generate_series(1, $1) n`,
      [scale.itemsPerKind],
    );
    await db.execute(
      `insert into test_plugin_inbox_owners (subject_id, conversation_id)
      select 'scale-plugin-' || n, 'scale:root:' || n
      from generate_series(1, $1) n`,
      [scale.itemsPerKind],
    );
    // The legacy write trigger of `junior_inbox_items` needs an owner for
    // the old owner columns, which no current read uses.
    await db.execute(
      `select set_config('junior.inbox_item_owner_kind', 'conversation', true),
        set_config('junior.inbox_item_owner_id', 'scale:root:1', true)`,
    );
    await db.execute(
      `insert into junior_inbox_items
        (id, kind, status, closed_at, title, body, subject_kind, subject_id,
         created_at, updated_at)
      select 'scale-item-' || subject.kind || '-' || n,
        case subject.kind when 'reply' then 'notice' else 'action' end,
        case when n <= $2 then 'open' else 'done' end,
        case when n > $2 then ${SEED_TIME} end,
        subject.title, subject.title, subject.kind,
        case subject.kind
          when 'question' then 'scale-question-' || n
          when 'reply' then 'scale:root:' || n
          when 'todo' then 'scale:root:' || n || ':1'
          else 'scale-plugin-' || n
        end,
        ${SEED_TIME} - n * interval '1 minute',
        ${SEED_TIME} - n * interval '1 minute'
      from generate_series(1, $1) n,
        (values ('question', null), ('reply', 'Scale reply'),
          ('todo', 'Scale To-do'), ('test:scale', 'Scale plugin item'))
          subject(kind, title)`,
      [scale.itemsPerKind, scale.openItemsPerKind],
    );
    await db.execute(
      `insert into junior_inbox_item_assignees (item_id, user_id)
      select item.id, 'scale-user-' || (1 + n % $1)
      from junior_inbox_items item,
        lateral (select (regexp_match(item.id, '(\\d+)$'))[1]::int n) owner
      where item.id like 'scale-item-%'`,
      [scale.users],
    );
    await db.execute(
      `insert into junior_inbox_item_conversations (item_id, conversation_id)
      select item.id, 'scale:root:' || (regexp_match(item.id, '(\\d+)$'))[1]
      from junior_inbox_items item
      where item.id like 'scale-item-%'`,
    );
  });
  await db.execute(`analyze ${SEEDED_TABLES.join(", ")}`);
}

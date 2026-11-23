// The edges of the Turn engine that the host chooses. The host builds one
// context and passes it in, so core reads no process globals.
import type { QueueProvider } from "@/chat/queue/provider";
import type { JuniorSqlDatabase } from "@/db/db";

/** What the host gives core: database, queue, and config values. */
export interface EngineContext {
  db: JuniorSqlDatabase;
  queue: QueueProvider;
  /** Names the invocation that holds a Turn's lease. */
  owner: string;
  /** How long a claim holds a Turn's lease. */
  leaseMs: number;
}

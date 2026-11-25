import { getChatConfig } from "@/chat/config";
import { logWarn } from "@/chat/logging";
import { openListenSession, type ListenSession } from "@/db/listen";

/**
 * The channel that the `junior_notify_versions` triggers send to. They send
 * an empty payload, so Postgres folds the notifications of one transaction
 * into one.
 */
const VERSIONS_CHANNEL = "junior_versions";

/** Lets an operator find this instance's session in `pg_stat_activity`. */
const APPLICATION_NAME = "junior-versions-listen";

/** One open stream's view of the shared session. */
export interface VersionChangeSubscriber {
  /** A write may have moved a token, so read the tokens again. */
  onChange(): void;
  /**
   * The session failed, and a `NOTIFY` can be lost until a new one listens.
   * The stream ends, and the client opens a new one that reads again.
   */
  onLost(): void;
}

/** The change signal that the versions streams of one API share. */
export interface VersionChanges {
  /**
   * Resolve once the shared session listens, so a read after it sees every
   * later change. The returned function unsubscribes. The last one out closes
   * the session, so an idle instance holds no Postgres connection.
   */
  subscribe(subscriber: VersionChangeSubscriber): Promise<() => void>;
}

/**
 * Share one direct Postgres `LISTEN` session among the versions streams of
 * one API instance. The session opens with the first stream and closes with
 * the last one.
 */
export function createVersionChanges(): VersionChanges {
  const subscribers = new Set<VersionChangeSubscriber>();
  let session: Promise<ListenSession> | undefined;

  const lose = (lost: Promise<ListenSession>, error: Error) => {
    if (session !== lost) return;
    session = undefined;
    logWarn("versions_stream.listener_lost", {
      "error.type": error.name,
      "exception.message": error.message,
      "app.versions_stream.subscribers": subscribers.size,
    });
    const ended = [...subscribers];
    subscribers.clear();
    for (const subscriber of ended) subscriber.onLost();
  };

  const connect = () => {
    const { sql } = getChatConfig();
    const opened: Promise<ListenSession> = openListenSession({
      applicationName: APPLICATION_NAME,
      channel: VERSIONS_CHANNEL,
      databaseUrl: sql.databaseUrl,
      driver: sql.driver,
      onLost: (error) => lose(opened, error),
      onNotify: () => {
        for (const subscriber of subscribers) subscriber.onChange();
      },
    });
    // The next subscriber opens a new session.
    opened.catch(() => {
      if (session === opened) session = undefined;
    });
    return opened;
  };

  return {
    async subscribe(subscriber) {
      session ??= connect();
      const current = session;
      subscribers.add(subscriber);
      try {
        await current;
      } catch (error) {
        subscribers.delete(subscriber);
        throw error;
      }
      return () => {
        if (!subscribers.delete(subscriber)) return;
        if (subscribers.size > 0 || session !== current) return;
        session = undefined;
        void current.then((listen) => listen.close());
      };
    },
  };
}

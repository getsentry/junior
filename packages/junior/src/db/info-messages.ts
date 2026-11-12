interface NoticeSource {
  on(
    event: "notice",
    listener: (notice: { message?: string; severity?: string }) => void,
  ): unknown;
}

/**
 * Send Postgres `INFO` messages from every pool connection to `onInfo`.
 * A migration uses `RAISE INFO` to report its result to the operator.
 * Postgres always sends `INFO` to the client. Its own messages, such as
 * "already exists, skipping", are `NOTICE`, so they stay out.
 */
export function forwardInfoMessages(
  pool: {
    on(event: "connect", listener: (client: NoticeSource) => void): unknown;
  },
  onInfo: (message: string) => void,
): void {
  pool.on("connect", (client) => {
    client.on("notice", (notice) => {
      if (notice.severity === "INFO" && notice.message) {
        onInfo(notice.message);
      }
    });
  });
}

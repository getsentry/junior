/**
 * The command line of the recording proxy.
 *
 * - `cli.ts serve`: read the configuration as JSON from stdin, and start the
 *   proxy. Print its address as one JSON line. Stop on SIGINT or SIGTERM.
 *   `client.ts` runs this command.
 * - `cli.ts prune <directory> <used-file>...`: delete the recordings that no
 *   used file lists.
 */
import { text } from "node:stream/consumers";
import { pruneRecordings } from "./recordings.ts";
import { startRecordingProxy } from "./server.ts";
import type { RecordingProxyAddress, RecordingProxyConfig } from "./types.ts";

const USAGE = `Usage:
  cli.ts serve < config.json
  cli.ts prune <directory> <used-file>...`;

const [command, ...args] = process.argv.slice(2);

if (command === "serve") {
  const config = JSON.parse(await text(process.stdin)) as RecordingProxyConfig;
  const proxy = await startRecordingProxy(config);
  const address: RecordingProxyAddress = {
    url: proxy.url,
    token: proxy.token,
    caCert: proxy.caCert,
  };
  process.stdout.write(`${JSON.stringify(address)}\n`);
  const stop = () => {
    proxy.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else if (command === "prune" && args.length >= 2) {
  const [directory, ...usedFiles] = args as [string, ...string[]];
  const count = await pruneRecordings(directory, usedFiles);
  process.stdout.write(`Deleted ${count} unused recordings\n`);
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

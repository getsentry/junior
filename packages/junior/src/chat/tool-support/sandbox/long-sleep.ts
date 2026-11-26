/**
 * Agents waited on CI and background processes with `sleep 240; check`, which
 * blocks the Turn for the whole guess even when the work ends early. A short
 * sleep inside an `until` loop is fine, so only one long fixed sleep fails.
 */
const MAX_SLEEP_SECONDS = 30;

// `sleep` in command position: at the start, after a separator, or after a
// shell keyword. `time.sleep(240)` and `--sleep 240` do not match.
const SLEEP_COMMAND =
  /(?:^|[\n;&|(){}]|\b(?:do|then|else)\s)\s*sleep((?:[ \t]+[^\s;&|()]+)+)/g;

const UNIT_SECONDS: Record<string, number> = {
  "": 1,
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
};

function sleepSeconds(args: string): number {
  return args
    .trim()
    .split(/[ \t]+/)
    .reduce((total, arg) => {
      if (arg === "infinity") return Number.POSITIVE_INFINITY;
      const match = /^(\d+(?:\.\d+)?|\.\d+)([smhd]?)$/.exec(arg);
      if (!match) return total;
      return total + Number(match[1]) * UNIT_SECONDS[match[2]!]!;
    }, 0);
}

export const LONG_SLEEP_MESSAGE = `sleep over ${MAX_SLEEP_SECONDS} seconds is not allowed. Wait for the thing itself: for a process that you started, \`wait <pid>\` or \`timeout <seconds> bash -c 'until <check>; do sleep 2; done'\`; for CI or other GitHub state, watchEvents, then end the Turn, and the Event starts your next Turn; for a delay, watchTimer.`;

/** Return whether a shell command waits with one fixed sleep over the limit. */
export function hasLongSleep(command: string): boolean {
  for (const match of command.matchAll(SLEEP_COMMAND)) {
    if (sleepSeconds(match[1]!) > MAX_SLEEP_SECONDS) return true;
  }
  return false;
}

import type { BenchEvent } from "./events";
import { eventText } from "./history";

/** One recorded Turn: its input text and how many agent calls it made. */
export interface BenchTurn {
  id: string;
  startSeq: number;
  endSeq: number;
  /** Instruction and agent-result text that started the Turn. */
  input: string;
  /** Seqs of assistant messages, one per agent call. */
  callSeqs: number[];
}

const QUERY_CHARS = 4_000;

/** Split the log into Turns from `turn_started` to `turn_completed`. */
export function turnsOf(events: readonly BenchEvent[]): BenchTurn[] {
  const turns: BenchTurn[] = [];
  let current: BenchTurn | undefined;
  for (const event of events) {
    const data = event.data;
    if (data.type === "turn_started") {
      current = {
        id: String(data["turnId"]),
        startSeq: event.seq,
        endSeq: event.seq,
        input: "",
        callSeqs: [],
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    current.endSeq = event.seq;
    if (data.type === "assistant_message") current.callSeqs.push(event.seq);
    // Runtime context blocks carry no request, so they are not the query.
    const authority = (data.provenance as { authority?: string } | undefined)
      ?.authority;
    const text = data.type === "user_message" ? eventText(data) : "";
    // Exported payloads can lose provenance; the context wrapper survives.
    const isContext =
      authority === "context" || text.startsWith("<runtime-turn-context>");
    if (text && !isContext) {
      if (current.input.length < QUERY_CHARS) {
        current.input = `${current.input}\n${text}`
          .trim()
          .slice(0, QUERY_CHARS);
      }
    }
    if (data.type === "turn_completed") current = undefined;
  }
  return turns;
}

/** The Turn that contains `seq`, or the last one that started before it. */
export function turnAt(
  turns: readonly BenchTurn[],
  seq: number,
): BenchTurn | undefined {
  let found: BenchTurn | undefined;
  for (const turn of turns) if (turn.startSeq <= seq) found = turn;
  return found;
}

/** The first Turn that starts after `seq`. */
export function firstTurnAfter(
  turns: readonly BenchTurn[],
  seq: number,
): BenchTurn | undefined {
  return turns.find((turn) => turn.startSeq > seq);
}

/** Turns with agent calls inside `(fromSeq, toSeq]`, and those call counts. */
export function callsBetween(
  turns: readonly BenchTurn[],
  fromSeq: number,
  toSeq: number,
): Array<{ turn: BenchTurn; calls: number }> {
  return turns
    .map((turn) => ({
      turn,
      calls: turn.callSeqs.filter((seq) => seq > fromSeq && seq <= toSeq)
        .length,
    }))
    .filter((row) => row.calls > 0);
}

/** Hide a value in a query, so retrieval cannot key on the answer. */
export function maskValue(query: string, value: string): string {
  if (!value) return query;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return query.replace(new RegExp(escaped, "gi"), "▢▢▢");
}

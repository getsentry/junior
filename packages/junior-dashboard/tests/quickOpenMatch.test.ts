import { expect, it } from "vitest";

import { quickOpenMatch } from "../src/client/components/quickOpenMatch";

// No describe block: CI parses the JUnit report, and each " > " in a test
// name adds an XML entity toward the parser's limit.
it("matches scattered letters in order, with no case", () => {
  expect(quickOpenMatch("Checkout latency triage", "CLT")?.indices).toEqual([
    0, 9, 11,
  ]);
  expect(quickOpenMatch("Checkout latency triage", "gc")).toBeUndefined();
});

it("needs every space-separated term", () => {
  expect(quickOpenMatch("Checkout latency triage", "chk tri")?.indices).toEqual(
    [0, 1, 4, 17, 18, 19],
  );
  expect(quickOpenMatch("Investigate checkout latency", "chk tri")).toBe(
    undefined,
  );
});

it("treats a camelCase capital as a word start", () => {
  const score = (label: string, query: string) =>
    quickOpenMatch(label, query)!.score;
  expect(score("Investigate isolationScope leak", "scope")).toBeGreaterThan(
    score("Investigate telescope leak", "scope"),
  );
  expect(quickOpenMatch("Fix getCurrentHub usage", "curnet")?.indices).toEqual([
    7, 8, 9, 10, 11, 12,
  ]);
});

it("ranks a word-start run over a mid-word run over a scatter", () => {
  const score = (label: string) => quickOpenMatch(label, "deploy")!.score;
  expect(score("Deploy notes")).toBeGreaterThan(score("Redeploy notes"));
  expect(score("Redeploy notes")).toBeGreaterThan(
    score("Debug the payments loy"),
  );
});

it("matches a word start within one typo, two for longer terms", () => {
  expect(quickOpenMatch("Issue triage", "isseu")?.indices).toEqual([
    0, 1, 2, 3, 4,
  ]);
  expect(quickOpenMatch("Customer escalation", "escelation")).toBeDefined();
  expect(quickOpenMatch("Checkout latency triage", "chekcout")).toBeDefined();
  expect(
    quickOpenMatch("Checkout latency triage", "chheckkout")?.indices,
  ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(quickOpenMatch("Package self-update", "slef-update")).toBeDefined();
  expect(quickOpenMatch("Checkout latency triage", "cehkcuot")).toBeUndefined();
  // Short terms need their letters in order.
  expect(quickOpenMatch("Uptime alerts", "tpi")).toBeUndefined();
});

it("ranks a typo below a tight scatter and above a loose one", () => {
  const score = (label: string, query: string) =>
    quickOpenMatch(label, query)!.score;
  expect(score("Who is betegon on GitHub", "bategon")).toBeGreaterThan(
    score("Snuba timeout investigation", "bategon"),
  );
  expect(score("Checkout latency triage", "chklat")).toBeGreaterThan(
    score("Checkout latency triage", "chekcout"),
  );
});

it("keeps label indices when lowercasing adds characters", () => {
  expect(quickOpenMatch("İstanbul latency", "latency")?.indices).toEqual([
    9, 10, 11, 12, 13, 14, 15,
  ]);
  expect(quickOpenMatch("İstanbul latency", "ist")).toEqual(
    quickOpenMatch("Istanbul latency", "ist"),
  );
});

it("keeps surrogate pairs whole", () => {
  expect(quickOpenMatch("Ship 🚀 now", "🚀")?.indices).toEqual([5, 6]);
});

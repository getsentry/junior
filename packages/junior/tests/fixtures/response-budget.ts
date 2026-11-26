import { expect } from "vitest";

/**
 * The most JSON chars of the largest item in each list of a response body,
 * by a dot path from the body, such as `conversations` or
 * `conversations.threads`. A path step into a list goes into each of its
 * items. An item leaves out a nested list that has its own entry, so each
 * entry budgets only the item's own fields.
 */
export type ResponseBudget = Record<string, number>;

function chars(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function fieldsOf(value: unknown): [string, unknown][] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function itemsAt(body: unknown, path: string): unknown[] {
  let values = [body];
  for (const key of path.split(".")) {
    values = values.flatMap((value) => {
      const next = fieldsOf(value).find(([field]) => field === key)?.[1];
      return Array.isArray(next) ? next : [];
    });
  }
  return values;
}

function biggestFields(fields: [string, unknown][]): string {
  return fields
    .map(([field, value]) => [field, chars(value)] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([field, size]) => `${field} ${size}`)
    .join(", ");
}

/**
 * Assert that the JSON body of `call` stays within a size budget. Set the
 * budget to the measured value. Lower it when a change sends less. Do not
 * raise it to pass. Returns the response with its body unread.
 */
export async function expectResponseBudget(
  call: () => Response | Promise<Response>,
  budget: ResponseBudget,
): Promise<Response> {
  const response = await call();
  const body: unknown = await response.clone().json();
  const paths = Object.keys(budget);
  for (const path of paths) {
    const nested = new Set(
      paths.flatMap((other) =>
        other.startsWith(`${path}.`) &&
        !other.slice(path.length + 1).includes(".")
          ? [other.slice(path.length + 1)]
          : [],
      ),
    );
    const items = itemsAt(body, path).map((item) =>
      fieldsOf(item).filter(([field]) => !nested.has(field)),
    );
    expect(items.length, `no item was measured at ${path}`).toBeGreaterThan(0);
    const [largest] = items
      .map((fields) => ({ fields, size: chars(Object.fromEntries(fields)) }))
      .sort((a, b) => b.size - a.size);
    expect(
      largest!.size,
      `largest ${path} item is ${largest!.size} chars. Biggest fields: ${biggestFields(largest!.fields)}`,
    ).toBeLessThanOrEqual(budget[path]!);
  }
  return response;
}

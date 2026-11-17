import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReviewItemActions } from "../src/client/review-desk/ReviewItemActions";
import { readMockReviewItems } from "../src/mock-reporting/review-items";

const [seed] = readMockReviewItems(Date.now(), {});
const item = { ...seed!, canTake: true, kind: "notice" as const };

function buttons(props: { dismiss?: boolean; take?: string | false }) {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ReviewItemActions item={item} {...props} />
    </QueryClientProvider>,
  );
  return [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(
    ([, label]) => label,
  );
}

describe("review item actions", () => {
  it("shows Take and Dismiss unless the caller leaves them out", () => {
    expect(buttons({})).toEqual(["Take", "Dismiss"]);
    expect(buttons({ dismiss: false, take: "Take it" })).toEqual(["Take it"]);
    expect(buttons({ dismiss: false, take: false })).toEqual([]);
  });
});

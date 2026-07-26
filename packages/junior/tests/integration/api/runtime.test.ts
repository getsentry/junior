import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { runtimeInfoReportSchema } from "@/api/schema";

describe("runtime API route", () => {
  test("serves runtime metadata", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/runtime",
    );

    expect(response.status).toBe(200);
    runtimeInfoReportSchema.parse(await response.json());
  });
});

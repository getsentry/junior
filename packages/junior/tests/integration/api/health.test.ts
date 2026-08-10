import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { healthReportSchema } from "@/api/schema";

describe("health API route", () => {
  test("serves the authenticated health report", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/health",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    healthReportSchema.parse(await response.json());
  });

  test("keeps missing routes out of shared caches", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/missing",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

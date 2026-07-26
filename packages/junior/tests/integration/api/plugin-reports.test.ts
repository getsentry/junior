import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { pluginOperationalReportFeedSchema } from "@/api/schema";

describe("plugin reports API route", () => {
  test("serves the operational report feed", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/plugin-reports",
    );

    expect(response.status).toBe(200);
    pluginOperationalReportFeedSchema.parse(await response.json());
  });
});

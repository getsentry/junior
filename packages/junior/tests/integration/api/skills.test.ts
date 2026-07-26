import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { skillReportsSchema } from "@/api/schema";

describe("skills API route", () => {
  test("serves discovered skills", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/skills",
    );

    expect(response.status).toBe(200);
    skillReportsSchema.parse(await response.json());
  });
});

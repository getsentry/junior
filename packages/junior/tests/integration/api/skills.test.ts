import { describe, expect, test } from "vitest";
import { createJuniorApi } from "@/api";
import { skillDetailReportSchema, skillReportsSchema } from "@/api/schema";

describe("skills API route", () => {
  test("serves discovered skills", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/skills",
    );

    expect(response.status).toBe(200);
    skillReportsSchema.parse(await response.json());
  });

  test("serves one skill with its authored body", async () => {
    const api = createJuniorApi();
    const skills = skillReportsSchema.parse(
      await (await api.request("http://localhost/api/skills")).json(),
    );
    const listed = skills[0];
    expect(listed).toBeDefined();

    const response = await api.request(
      `http://localhost/api/skills/${encodeURIComponent(listed!.name)}`,
    );

    expect(response.status).toBe(200);
    const skill = skillDetailReportSchema.parse(await response.json());
    expect(skill).toMatchObject(listed!);
    expect(skill.body).not.toBe("");
    expect(skill.body).not.toMatch(/^---/);
  });

  test("returns 404 for an unknown skill", async () => {
    const response = await createJuniorApi().request(
      "http://localhost/api/skills/no-such-skill",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Skill not found." });
  });
});

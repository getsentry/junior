import { describe, expect, it } from "vitest";
import { readDirectDatabaseUrl } from "@/db/direct-url";

describe("readDirectDatabaseUrl", () => {
  it("uses the direct Neon endpoint for a pooled URL", () => {
    expect(
      readDirectDatabaseUrl(
        "postgresql://user:p%40ss@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      ),
    ).toBe(
      "postgresql://user:p%40ss@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    );
  });

  it("keeps other URLs", () => {
    for (const databaseUrl of [
      "postgresql://user:pass@ep-cool-darkness-123456.us-east-2.aws.neon.tech/neondb",
      "postgresql://user:pass@db-pooler.example.com/app",
      "postgres://junior:junior@localhost:54322/junior",
      "postgresql://junior@/junior?host=/var/run/postgresql",
    ]) {
      expect(readDirectDatabaseUrl(databaseUrl)).toBe(databaseUrl);
    }
  });
});

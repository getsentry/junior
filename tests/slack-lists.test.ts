import { describe, expect, it } from "vitest";
import { inferListColumnMap } from "@/chat/slack-actions/lists";

describe("inferListColumnMap", () => {
  it("detects canonical todo columns", () => {
    const map = inferListColumnMap([
      { id: "c1", key: "task", name: "Task", type: "rich_text", is_primary_column: true },
      { id: "c2", key: "completed", name: "Done", type: "checkbox" },
      { id: "c3", key: "assignee", name: "Owner", type: "user" },
      { id: "c4", key: "due_date", name: "Due", type: "date" }
    ]);

    expect(map.titleColumnId).toBe("c1");
    expect(map.completedColumnId).toBe("c2");
    expect(map.assigneeColumnId).toBe("c3");
    expect(map.dueDateColumnId).toBe("c4");
  });
});

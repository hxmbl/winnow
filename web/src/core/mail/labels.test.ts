import { describe, expect, it } from "vitest";
import {
  labelHue,
  labelLeaf,
  labelsOn,
  applyLabelChange,
  filterLabels,
  isUserLabelId,
  labelChanges,
  labelCheck,
  labelNameProblem,
  sortLabels,
  userLabelIds,
  type LabelCheck,
} from "./labels";

const LABELS = [
  { id: "Label_3", name: "Travel" },
  { id: "Label_1", name: "receipts" },
  { id: "Label_2", name: "Work/Clients" },
];

describe("user label ids", () => {
  it("are Gmail's Label_<n> ids, never system labels", () => {
    expect(isUserLabelId("Label_12")).toBe(true);
    for (const id of ["INBOX", "UNREAD", "CATEGORY_SOCIAL", "IMPORTANT", "Label_", "label_3", "Label_x"]) {
      expect(isUserLabelId(id)).toBe(false);
    }
    expect(userLabelIds(["INBOX", "Label_2", "UNREAD", "Label_9"])).toEqual(["Label_2", "Label_9"]);
  });
});

describe("labelCheck", () => {
  const a = { labels: ["Label_1"] };
  const b = { labels: ["Label_1", "Label_2"] };
  const c = {};
  it("is all, some or none across the targets", () => {
    expect(labelCheck([a, b], "Label_1")).toBe("all");
    expect(labelCheck([a, b], "Label_2")).toBe("some");
    expect(labelCheck([a, b, c], "Label_3")).toBe("none");
    expect(labelCheck([a, c], "Label_1")).toBe("some");
    expect(labelCheck([], "Label_1")).toBe("none");
  });
});

describe("labelChanges", () => {
  const before = new Map<string, LabelCheck>([
    ["Label_1", "all"],
    ["Label_2", "some"],
    ["Label_3", "none"],
  ]);
  it("adds what became checked and removes what became clear", () => {
    const after = new Map<string, LabelCheck>([
      ["Label_1", "none"],
      ["Label_2", "all"],
      ["Label_3", "all"],
    ]);
    expect(labelChanges(before, after)).toEqual({ add: ["Label_2", "Label_3"], remove: ["Label_1"] });
  });
  it("leaves a mixed label alone, and sends nothing for no change", () => {
    expect(labelChanges(before, new Map(before))).toEqual({ add: [], remove: [] });
  });
  it("treats a new label as unchecked before", () => {
    expect(labelChanges(before, new Map([["Label_9", "all"]]))).toEqual({ add: ["Label_9"], remove: [] });
  });
});

describe("applyLabelChange", () => {
  it("removes, then adds without duplicates", () => {
    expect(applyLabelChange(["Label_1", "Label_2"], ["Label_2", "Label_3"], ["Label_1"])).toEqual(["Label_2", "Label_3"]);
    expect(applyLabelChange(undefined, ["Label_1"], [])).toEqual(["Label_1"]);
  });
});

describe("labelNameProblem", () => {
  it("accepts a new name, nested ones included", () => {
    expect(labelNameProblem("Family", LABELS)).toBeNull();
    expect(labelNameProblem("Work/Hiring", LABELS)).toBeNull();
  });
  it("says why a name cannot be used", () => {
    expect(labelNameProblem("  ", LABELS)).toMatch(/Type a name/);
    expect(labelNameProblem("Inbox", LABELS)).toMatch(/Gmail's own/);
    expect(labelNameProblem("Receipts", LABELS)).toMatch(/already a label/);
    expect(labelNameProblem("Work/", LABELS)).toMatch(/each side/);
    expect(labelNameProblem("x".repeat(226), LABELS)).toMatch(/225/);
  });
});

describe("listing", () => {
  it("sorts by name, ignoring case", () => {
    expect(sortLabels(LABELS).map((label) => label.name)).toEqual(["receipts", "Travel", "Work/Clients"]);
  });
  it("filters by a case-insensitive substring", () => {
    expect(filterLabels(LABELS, "CLI").map((label) => label.id)).toEqual(["Label_2"]);
    expect(filterLabels(LABELS, " ")).toHaveLength(3);
  });
});

describe("label chips", () => {
  const names = new Map([
    ["Label_1", "Travel"],
    ["Label_3", "Work/Northwind"],
    ["Label_2", "Receipts"],
  ]);

  it("names a message's labels in name order, skipping unknown and hidden ones", () => {
    expect(labelsOn(["Label_3", "Label_1", "Label_9"], names).map((l) => l.name)).toEqual(["Travel", "Work/Northwind"]);
    expect(labelsOn(["Label_3", "Label_1"], names, "Label_1").map((l) => l.name)).toEqual(["Work/Northwind"]);
    expect(labelsOn(undefined, names)).toEqual([]);
  });

  it("shortens a nested name to its last part and colours a name the same way every time", () => {
    expect(labelLeaf("Work/Northwind")).toBe("Northwind");
    expect(labelLeaf("Travel")).toBe("Travel");
    expect(labelHue("Travel")).toBe(labelHue("Travel"));
    expect(labelHue("Travel")).toBeGreaterThanOrEqual(0);
    expect(labelHue("Travel")).toBeLessThan(360);
    expect(labelHue("Travel")).not.toBe(labelHue("Receipts"));
  });
});

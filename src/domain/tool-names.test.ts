import { describe, it, expect } from "vitest";
import { namespaceTool, parseTool } from "./tool-names.js";

describe("tool namespacing", () => {
  it("round-trips prefix + name", () => {
    const full = namespaceTool("gdrive", "search_files");
    expect(full).toBe("gdrive__search_files");
    expect(parseTool(full)).toEqual({ prefix: "gdrive", name: "search_files" });
  });

  it("keeps only the first separator as the split point", () => {
    expect(parseTool("github__list__repos")).toEqual({ prefix: "github", name: "list__repos" });
  });

  it("returns null for non-namespaced names", () => {
    expect(parseTool("plainname")).toBeNull();
    expect(parseTool("__leading")).toBeNull();
    expect(parseTool("trailing__")).toBeNull();
  });
});

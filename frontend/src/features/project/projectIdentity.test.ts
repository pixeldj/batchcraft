import { describe, expect, it } from "vitest";

import { slugifyProjectName } from "./projectIdentity";

describe("slugifyProjectName", () => {
  it("lowercases words and joins whitespace", () => {
    expect(slugifyProjectName("  Portrait Studies  ")).toBe("portrait-studies");
  });

  it("normalizes punctuation and repeated separators", () => {
    expect(slugifyProjectName("Sci-Fi___Portraits!!! 2026")).toBe("sci-fi-portraits-2026");
  });

  it("treats accented characters as non-ASCII separators", () => {
    expect(slugifyProjectName("Café Étude")).toBe("caf-tude");
  });

  it("allows an empty result for an entirely non-ASCII name", () => {
    expect(slugifyProjectName("日本語")).toBe("");
  });
});

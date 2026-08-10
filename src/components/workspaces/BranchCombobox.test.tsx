import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../../test/render";
import BranchCombobox, { filterBranches } from "./BranchCombobox";

const branches = ["main", "feature/login", "feature/logout", "release-1.2"];

describe("BranchCombobox", () => {
  it("renders a typeable input defaulting to the New branch placeholder", async () => {
    const html = await renderToHtml(
      createElement(BranchCombobox, { branches, value: "", onChange: () => {} }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('placeholder="New branch"');
  });

  it("shows the committed branch as the input value", async () => {
    const html = await renderToHtml(
      createElement(BranchCombobox, { branches, value: "main", onChange: () => {} }),
    );
    expect(html).toContain('value="main"');
  });

  it("disables the input while branches are loading", async () => {
    const html = await renderToHtml(
      createElement(BranchCombobox, { branches: "loading", value: "", onChange: () => {} }),
    );
    expect(html).toContain("disabled");
  });

  it("disables the input when branch loading errored", async () => {
    const html = await renderToHtml(
      createElement(BranchCombobox, { branches: "error", value: "", onChange: () => {} }),
    );
    expect(html).toContain("disabled");
  });
});

describe("filterBranches", () => {
  it("always offers the New branch reset first", () => {
    const [first] = filterBranches(branches, "", "");
    expect(first).toEqual({ label: "New branch", value: "" });
  });

  it("lists every branch when the query is empty", () => {
    const opts = filterBranches(branches, "", "");
    expect(opts.map((o) => o.value)).toEqual(["", ...branches]);
  });

  it("filters to branches matching the typed text, case-insensitively", () => {
    const opts = filterBranches(branches, "LOGIN", "");
    expect(opts.map((o) => o.value)).toEqual(["", "feature/login"]);
  });

  it("matches on a substring anywhere in the name", () => {
    const opts = filterBranches(branches, "feature/log", "");
    expect(opts.map((o) => o.value)).toEqual(["", "feature/login", "feature/logout"]);
  });

  it("returns only the reset when nothing matches", () => {
    const opts = filterBranches(branches, "nope", "");
    expect(opts.map((o) => o.value)).toEqual([""]);
  });

  it("treats a whitespace-only query as no search and lists everything", () => {
    const opts = filterBranches(branches, "   ", "");
    expect(opts.map((o) => o.value)).toEqual(["", ...branches]);
  });

  it("trims surrounding whitespace before matching", () => {
    const opts = filterBranches(branches, "  login  ", "");
    expect(opts.map((o) => o.value)).toEqual(["", "feature/login"]);
  });

  it("shows the full list when the query equals the committed branch", () => {
    // After a branch is picked the input echoes it; that isn't an active search.
    const opts = filterBranches(branches, "main", "main");
    expect(opts.map((o) => o.value)).toEqual(["", ...branches]);
  });

  it("treats loading/error sentinels as an empty branch list", () => {
    expect(filterBranches("loading", "x", "")).toEqual([{ label: "New branch", value: "" }]);
    expect(filterBranches("error", "", "")).toEqual([{ label: "New branch", value: "" }]);
  });
});

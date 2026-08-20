import { describe, expect, it } from "bun:test";
import { clipboardSafeText, clipboardSafeUrl } from "./clipboard";

describe("clipboardSafeText", () => {
  // Provider-supplied names reach a block that is joined with newlines, where
  // one embedded in a field would forge a line of its own.
  it("strips control and formatting characters", () => {
    expect(clipboardSafeText("build\n(linux)\r")).toBe("build(linux)");
    expect(clipboardSafeText("report‮sj.exe")).toBe("reportsj.exe");
  });

  it("leaves ordinary text alone", () => {
    expect(clipboardSafeText("ci / build (ubuntu-latest)")).toBe("ci / build (ubuntu-latest)");
  });
});

describe("clipboardSafeUrl", () => {
  it("passes http and https through", () => {
    expect(clipboardSafeUrl("https://github.com/acme/web/pull/1")).toBe(
      "https://github.com/acme/web/pull/1",
    );
    expect(clipboardSafeUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
  });

  // The same allowlist `openExternal` applies: what the open path refuses to
  // open shouldn't reach the clipboard, where it is handed to someone else.
  it("refuses a scheme openExternal would refuse", () => {
    expect(clipboardSafeUrl("javascript:alert(1)")).toBeNull();
    expect(clipboardSafeUrl("file:///etc/passwd")).toBeNull();
    expect(clipboardSafeUrl("data:text/html,<script>")).toBeNull();
  });

  it("refuses what isn't a URL at all", () => {
    expect(clipboardSafeUrl("not a url")).toBeNull();
    expect(clipboardSafeUrl(null)).toBeNull();
    expect(clipboardSafeUrl("")).toBeNull();
  });

  it("strips control characters before deciding", () => {
    expect(clipboardSafeUrl("https://example.test/a\nrm -rf /")).toBe(
      "https://example.test/arm -rf /",
    );
  });
});

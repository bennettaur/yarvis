import { describe, expect, it } from "bun:test";
import { UrlSafetyError, validateOutboundUrl } from "./urlSafety.ts";

describe("validateOutboundUrl", () => {
  it("accepts a plain https url", () => {
    const url = validateOutboundUrl("https://api.example.com/v1/chat");
    expect(url.hostname).toBe("api.example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateOutboundUrl("file:///etc/passwd")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("javascript:alert(1)")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("data:text/plain,hi")).toThrow(UrlSafetyError);
  });

  it("rejects urls with embedded credentials", () => {
    expect(() => validateOutboundUrl("http://user:pw@example.com/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://user@example.com/")).toThrow(UrlSafetyError);
  });

  it("rejects literal loopback addresses", () => {
    expect(() => validateOutboundUrl("http://127.0.0.1/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://127.255.255.255/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://[::1]/")).toThrow(UrlSafetyError);
  });

  it("rejects RFC 1918 ranges", () => {
    expect(() => validateOutboundUrl("http://10.0.0.1/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://192.168.1.1/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://172.16.0.1/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://172.31.255.255/")).toThrow(UrlSafetyError);
  });

  it("rejects link-local and cloud-metadata 169.254/16", () => {
    expect(() => validateOutboundUrl("http://169.254.169.254/")).toThrow(UrlSafetyError);
  });

  it("rejects unique-local IPv6 (fc00::/7) and link-local (fe80::/10)", () => {
    expect(() => validateOutboundUrl("http://[fc00::1]/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://[fd12:3456::1]/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://[fe80::1]/")).toThrow(UrlSafetyError);
  });

  it("rejects 0.0.0.0/8 catch-all and 100.64/10 CGNAT", () => {
    expect(() => validateOutboundUrl("http://0.0.0.0/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://0.1.2.3/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://100.64.0.1/")).toThrow(UrlSafetyError);
  });

  it("rejects IPv4-mapped IPv6 literals for private embedded addresses", () => {
    // Node's URL parser normalizes `[::ffff:169.254.169.254]` to the hex form
    // `::ffff:a9fe:a9fe`; the private check must decode it, not just the dotted form.
    expect(() => validateOutboundUrl("http://[::ffff:169.254.169.254]/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://[::ffff:10.0.0.1]/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://[::ffff:192.168.1.1]/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://[::ffff:127.0.0.1]/")).toThrow(UrlSafetyError);
  });

  it("accepts IPv4-mapped IPv6 literals for public embedded addresses", () => {
    // Node normalizes the mapped literal to its hex form (`::ffff:808:808`).
    expect(validateOutboundUrl("http://[::ffff:8.8.8.8]/").hostname).toBe("[::ffff:808:808]");
  });

  it("rejects hostname aliases for loopback", () => {
    expect(() => validateOutboundUrl("http://localhost/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://anything.local/")).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://anything.localhost/")).toThrow(UrlSafetyError);
  });

  it("accepts public IPs literally", () => {
    expect(validateOutboundUrl("http://8.8.8.8/").hostname).toBe("8.8.8.8");
    expect(validateOutboundUrl("https://[2001:4860:4860::8888]/").hostname).toBe(
      "[2001:4860:4860::8888]",
    );
  });
});

describe("validateOutboundUrl with allowLoopback", () => {
  const opts = { allowLoopback: true };

  it("accepts loopback literals for a local provider (e.g. Ollama)", () => {
    expect(validateOutboundUrl("http://127.0.0.1:11434/", opts).hostname).toBe("127.0.0.1");
    expect(validateOutboundUrl("http://127.255.255.255/", opts).hostname).toBe("127.255.255.255");
    expect(validateOutboundUrl("http://[::1]:11434/", opts).hostname).toBe("[::1]");
  });

  it("accepts loopback hostname aliases", () => {
    expect(validateOutboundUrl("http://localhost:11434/", opts).hostname).toBe("localhost");
    expect(validateOutboundUrl("http://ollama.localhost/", opts).hostname).toBe("ollama.localhost");
  });

  it("still rejects non-loopback private ranges", () => {
    expect(() => validateOutboundUrl("http://10.0.0.1/", opts)).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://192.168.1.1/", opts)).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://169.254.169.254/", opts)).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://[fe80::1]/", opts)).toThrow(UrlSafetyError);
  });

  it("accepts IPv4-mapped IPv6 loopback but not mapped non-loopback", () => {
    expect(validateOutboundUrl("http://[::ffff:127.0.0.1]/", opts).hostname).toBe(
      "[::ffff:7f00:1]",
    );
    expect(() => validateOutboundUrl("http://[::ffff:169.254.169.254]/", opts)).toThrow(
      UrlSafetyError,
    );
  });

  it("still rejects .local mDNS hosts, which are not loopback", () => {
    expect(() => validateOutboundUrl("http://anything.local/", opts)).toThrow(UrlSafetyError);
  });

  it("still enforces scheme and credential rules", () => {
    expect(() => validateOutboundUrl("file:///etc/passwd", opts)).toThrow(UrlSafetyError);
    expect(() => validateOutboundUrl("http://user:pw@127.0.0.1/", opts)).toThrow(UrlSafetyError);
  });
});

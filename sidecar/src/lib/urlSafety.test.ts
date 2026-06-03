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

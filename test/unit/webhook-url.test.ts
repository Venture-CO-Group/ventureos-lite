import { describe, it, expect } from "vitest";
import { isPrivateAddress, validateWebhookUrl } from "../../src/modules/webhooks/url";

/**
 * An outbound webhook is a feature that makes the server fetch a URL somebody
 * typed. That is server-side request forgery with a settings panel — and this
 * server sits on a Docker network beside Postgres, Redis and the worker.
 *
 * These are the most important tests in the module.
 */
describe("what an Owner may point a webhook at", () => {
  it("accepts an ordinary public https endpoint", () => {
    const v = validateWebhookUrl("https://hooks.example.com/venture");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.url).toBe("https://hooks.example.com/venture");
  });

  it("keeps the path and the query, which a receiver routes on", () => {
    const v = validateWebhookUrl("https://example.com/a/b?token=x&y=2");
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.url).toContain("/a/b?token=x&y=2");
  });

  it("refuses plain http", () => {
    // The payload carries lead names and contract totals.
    const v = validateWebhookUrl("http://hooks.example.com/venture");
    expect(v.ok).toBe(false);
  });

  it("refuses every way of naming this machine", () => {
    for (const url of [
      "https://localhost/hook",
      "https://localhost:3000/api/leads",
      "https://LOCALHOST/hook",
      "https://localhost.localdomain/hook",
      "https://something.localhost/hook",
    ]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses the compose service names", () => {
    // `db`, `redis`, `app` and `worker` are all reachable from inside the
    // container and none of them are on the internet.
    for (const url of ["https://db/x", "https://redis/x", "https://app/api/x", "https://worker/x"]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses a bare IP address, public or not", () => {
    // Naming a host by IP is how every private range and the cloud metadata
    // endpoint gets reached, and no legitimate integration needs it.
    for (const url of [
      "https://127.0.0.1/hook",
      "https://10.0.0.5/hook",
      "https://172.16.4.4/hook",
      "https://192.168.1.1/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://8.8.8.8/hook",
      "https://[::1]/hook",
      "https://2130706433/hook",
      "https://0x7f000001/hook",
    ]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses the cloud metadata hostnames", () => {
    for (const url of [
      "https://metadata/computeMetadata/v1/",
      "https://metadata.google.internal/x",
      "https://instance-data/x",
    ]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses internal suffixes", () => {
    for (const url of ["https://nas.local/x", "https://db.internal/x"]) {
      expect(validateWebhookUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses a single-label hostname", () => {
    // Every internal service name is one label. A public name has a dot.
    expect(validateWebhookUrl("https://intranet/hook").ok).toBe(false);
  });

  it("refuses credentials in the URL", () => {
    expect(validateWebhookUrl("https://user:pass@example.com/hook").ok).toBe(false);
  });

  it("refuses a fragment", () => {
    expect(validateWebhookUrl("https://example.com/hook#x").ok).toBe(false);
  });

  it("refuses nonsense and empties without throwing", () => {
    for (const url of ["", "   ", "not a url", "ftp://example.com/x", "javascript:alert(1)"]) {
      expect(validateWebhookUrl(url).ok, JSON.stringify(url)).toBe(false);
    }
  });

  it("refuses an absurdly long URL", () => {
    expect(validateWebhookUrl(`https://example.com/${"a".repeat(600)}`).ok).toBe(false);
  });

  it("says why, in words a person can act on", () => {
    const v = validateWebhookUrl("http://example.com/x");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/https/);
  });
});

/**
 * The string check cannot see DNS: a perfectly public hostname may have an A
 * record pointing at 127.0.0.1. The worker resolves the name and asks this.
 */
describe("addresses the worker refuses to connect to", () => {
  it("catches loopback, the private ranges and link-local", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254", // the cloud metadata endpoint
      "100.64.0.1", // carrier-grade NAT
      "224.0.0.1", // multicast
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.37.190", "172.32.0.1", "9.255.255.255"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("catches the IPv6 forms, including IPv4-mapped loopback", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("treats anything unparseable as private", () => {
    // Refusing to connect to something we cannot classify is the safe
    // direction to be wrong in.
    for (const ip of ["", "not-an-ip", "1.2.3", "999.1.1.1", "1.2.3.4.5"]) {
      expect(isPrivateAddress(ip), JSON.stringify(ip)).toBe(true);
    }
  });
});

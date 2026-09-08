import { describe, it, expect } from "vitest";
import {
  generateWebhookSecret,
  signPayload,
  verifyPayload,
} from "../../src/modules/webhooks/signature";
import { WEBHOOK_EVENTS, isWebhookEvent, labelFor, readEvents } from "../../src/modules/webhooks/events";
import { backoffFor } from "../../src/modules/webhooks/jobs";

/**
 * A receiver has to be able to tell our POST from anybody else's POST to the
 * same URL. A token in the URL cannot do that — it leaks into their access
 * logs, their proxy and their error tracker, and one captured request can be
 * replayed for ever.
 */
describe("signing a payload", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ event: "lead.created", data: { leadId: "abc" } });

  it("is stable for the same input", () => {
    expect(signPayload(secret, 1_700_000_000, body)).toBe(
      signPayload(secret, 1_700_000_000, body),
    );
  });

  it("changes with the body", () => {
    const a = signPayload(secret, 1_700_000_000, body);
    const b = signPayload(secret, 1_700_000_000, `${body} `);
    expect(a).not.toBe(b);
  });

  it("changes with the timestamp, which is what makes a replay detectable", () => {
    const a = signPayload(secret, 1_700_000_000, body);
    const b = signPayload(secret, 1_700_000_001, body);
    expect(a).not.toBe(b);
  });

  it("changes with the secret", () => {
    expect(signPayload("a", 1, body)).not.toBe(signPayload("b", 1, body));
  });

  it("cannot be forged by moving the boundary between timestamp and body", () => {
    // `${ts}.${body}` — a signature over "1700000000" + ".x" must not equal one
    // over "1700000000." + "x". The separator is inside the signed material.
    const a = signPayload(secret, 1_700_000_000, ".x");
    const b = signPayload(secret, 1_700_000_0, "00..x");
    expect(a).not.toBe(b);
  });

  it("is 64 hex characters", () => {
    expect(signPayload(secret, 1, body)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("verifying it, the way a receiver should", () => {
  const secret = "s3cret";
  const body = '{"event":"x"}';
  const now = () => Math.floor(Date.now() / 1000);

  it("accepts a fresh, correct signature", () => {
    const ts = now();
    expect(verifyPayload(secret, ts, body, signPayload(secret, ts, body))).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const ts = now();
    expect(verifyPayload("other", ts, body, signPayload(secret, ts, body))).toBe(false);
  });

  it("rejects a tampered body", () => {
    const ts = now();
    const sig = signPayload(secret, ts, body);
    expect(verifyPayload(secret, ts, '{"event":"y"}', sig)).toBe(false);
  });

  it("rejects a replay outside the tolerance window", () => {
    const ts = now() - 3600;
    expect(verifyPayload(secret, ts, body, signPayload(secret, ts, body))).toBe(false);
    // ...and accepts it inside a window the receiver widened deliberately.
    expect(verifyPayload(secret, ts, body, signPayload(secret, ts, body), 7200)).toBe(true);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on a length mismatch; the length is checked first.
    expect(() => verifyPayload(secret, now(), body, "short")).not.toThrow();
    expect(verifyPayload(secret, now(), body, "short")).toBe(false);
    expect(verifyPayload(secret, now(), body, "")).toBe(false);
  });
});

describe("the secret", () => {
  it("is 64 hex characters of real randomness", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("the event catalogue", () => {
  it("has unique, dotted, lower-case ids", () => {
    const ids = WEBHOOK_EVENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("describes every event, because the settings screen is the documentation", () => {
    for (const e of WEBHOOK_EVENTS) {
      expect(e.label.length).toBeGreaterThan(3);
      expect(e.hint.length).toBeGreaterThan(10);
    }
  });

  it("recognises only what it lists", () => {
    expect(isWebhookEvent("lead.stage_changed")).toBe(true);
    expect(isWebhookEvent("lead.exploded")).toBe(false);
  });

  it("drops anything unrecognised from a stored subscription list", () => {
    // An id that no longer exists cannot fire, so keeping it would only
    // mislead whoever reads the settings screen.
    expect(readEvents(["lead.created", "nope", 7, null])).toEqual(["lead.created"]);
    expect(readEvents("lead.created")).toEqual([]);
    expect(readEvents(null)).toEqual([]);
    expect(readEvents({ 0: "lead.created" })).toEqual([]);
  });

  it("de-duplicates and returns catalogue order, so the panel renders stably", () => {
    const out = readEvents(["deal.won", "lead.created", "deal.won"]);
    expect(out).toEqual(["lead.created", "deal.won"]);
  });

  it("falls back to the raw id rather than an empty label", () => {
    expect(labelFor("lead.created")).toBe("Új lead");
    expect(labelFor("webhook.test")).toBe("webhook.test");
  });
});

describe("retry backoff", () => {
  it("climbs, and then stops climbing", () => {
    // About a minute, five, twenty-five, two hours, ten hours — spanning an
    // overnight outage without hammering anybody.
    expect(backoffFor(1)).toBe(1);
    expect(backoffFor(2)).toBe(5);
    expect(backoffFor(3)).toBe(25);
    expect(backoffFor(4)).toBe(120);
    expect(backoffFor(5)).toBe(600);
    expect(backoffFor(6)).toBe(600);
    expect(backoffFor(99)).toBe(600);
  });

  it("never returns zero or a negative delay", () => {
    for (const n of [-5, 0, 1]) expect(backoffFor(n)).toBeGreaterThan(0);
  });
});

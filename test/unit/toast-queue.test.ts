import { describe, it, expect } from "vitest";
import {
  DWELL_SECONDS,
  MAX_VISIBLE,
  UNDO_SECONDS,
  announcement,
  dismiss,
  markBusy,
  refuse,
  secondsFor,
  tick,
  visible,
  waiting,
  type QueuedToast,
} from "../../src/lib/client/toast-queue";

let key = 0;
function toast(over: Partial<QueuedToast> = {}): QueuedToast {
  return {
    key: ++key,
    variant: "info",
    message: `toast ${key}`,
    remaining: DWELL_SECONDS,
    ...over,
  };
}

/** N toasts, oldest first, as the provider would hold them. */
function stack(n: number, over: Partial<QueuedToast> = {}): QueuedToast[] {
  return Array.from({ length: n }, () => toast(over));
}

describe("the toast queue", () => {
  describe("how long each kind stays", () => {
    it("an ordinary toast dwells five seconds", () => {
      expect(secondsFor("success")).toBe(DWELL_SECONDS);
      expect(secondsFor("error")).toBe(DWELL_SECONDS);
      expect(secondsFor("info")).toBe(DWELL_SECONDS);
    });

    /** The playbook asks for six on the undo offer specifically. */
    it("an undo offer gets six", () => {
      expect(secondsFor("undoable")).toBe(UNDO_SECONDS);
      expect(UNDO_SECONDS).toBeGreaterThan(DWELL_SECONDS);
    });

    it("an explicit duration wins, and is never rounded to nothing", () => {
      expect(secondsFor("info", 12_000)).toBe(12);
      expect(secondsFor("info", 1)).toBe(1);
      expect(secondsFor("info", 0)).toBe(1);
    });

    /** An undo window is not a caller's decision — it matches the countdown. */
    it("an undo offer ignores a passed duration", () => {
      expect(secondsFor("undoable", 60_000)).toBe(UNDO_SECONDS);
    });
  });

  describe("what is on screen", () => {
    it("shows at most three", () => {
      expect(visible(stack(5))).toHaveLength(MAX_VISIBLE);
    });

    /**
     * The fourth WAITS. Displacing the first would mean a bulk action's burst
     * pushed its own earliest message off screen before it could be read.
     */
    it("keeps the rest queued rather than dropping them", () => {
      const q = stack(5);
      expect(waiting(q)).toBe(2);
      expect(visible(q).map((t) => t.key)).toEqual(q.slice(0, 3).map((t) => t.key));
    });

    it("says nothing is waiting when everything fits", () => {
      expect(waiting(stack(2))).toBe(0);
      expect(waiting([])).toBe(0);
    });
  });

  describe("the countdown", () => {
    it("ages the visible ones", () => {
      const q = tick(stack(2));
      expect(q.map((t) => t.remaining)).toEqual([DWELL_SECONDS - 1, DWELL_SECONDS - 1]);
    });

    /** The bug this rule prevents: appearing and vanishing in one frame. */
    it("leaves the queued ones untouched", () => {
      const q = tick(stack(5));
      expect(q.slice(0, 3).every((t) => t.remaining === DWELL_SECONDS - 1)).toBe(true);
      expect(q.slice(3).every((t) => t.remaining === DWELL_SECONDS)).toBe(true);
    });

    it("removes one that has run out, and promotes the next", () => {
      const q = [toast({ remaining: 1 }), ...stack(3)];
      const after = tick(q);
      expect(after).toHaveLength(3);
      expect(waiting(after)).toBe(0);
    });

    /** A toast waiting on its own server call must not expire underneath it. */
    it("never expires a busy toast", () => {
      let q = [toast({ remaining: 1, busy: true, variant: "undoable" })];
      for (let i = 0; i < 30; i++) q = tick(q);
      expect(q).toHaveLength(1);
      expect(q[0]!.remaining).toBe(1);
    });

    it("counts a whole stack down to empty", () => {
      let q = stack(3);
      for (let i = 0; i < DWELL_SECONDS; i++) q = tick(q);
      expect(q).toEqual([]);
    });
  });

  describe("dismissing", () => {
    it("removes just that one", () => {
      const q = stack(3);
      const after = dismiss(q, q[1]!.key);
      expect(after.map((t) => t.key)).toEqual([q[0]!.key, q[2]!.key]);
    });

    it("is a no-op for a key that is gone", () => {
      const q = stack(2);
      expect(dismiss(q, 9999)).toHaveLength(2);
    });
  });

  describe("a declined undo", () => {
    const offer = () =>
      toast({ variant: "undoable", message: "Moved 3 leads", undo: { id: "u1", label: "Moved 3 leads" } });

    it("replaces the offer with the reason and turns the toast into an error", () => {
      const t = offer();
      const q = refuse([t], t.key, "That has changed since.");
      expect(q[0]!.refusal).toBe("That has changed since.");
      expect(q[0]!.variant).toBe("error");
    });

    /** Long enough to read, not the one second left of a countdown. */
    it("gives the refusal a fresh window", () => {
      const t = offer();
      const q = refuse([{ ...t, remaining: 1 }], t.key, "Someone else changed this.");
      expect(q[0]!.remaining).toBe(UNDO_SECONDS);
    });

    it("clears the busy flag so the toast can expire again", () => {
      const t = offer();
      const q = refuse(markBusy([t], t.key, true), t.key, "No.");
      expect(q[0]!.busy).toBe(false);
      expect(tick(q)[0]!.remaining).toBe(UNDO_SECONDS - 1);
    });
  });

  describe("what the screen reader hears", () => {
    it("announces only the visible ones", () => {
      const q = [
        toast({ message: "One" }),
        toast({ message: "Two" }),
        toast({ message: "Three" }),
        toast({ message: "Four" }),
      ];
      expect(announcement(q)).toBe("One. Two. Three");
    });

    it("announces a refusal in place of the message it replaced", () => {
      const t = toast({ variant: "undoable", message: "Moved 3 leads" });
      expect(announcement(refuse([t], t.key, "Too late to undo that."))).toBe(
        "Too late to undo that.",
      );
    });

    it("is empty when nothing is up", () => {
      expect(announcement([])).toBe("");
    });
  });
});

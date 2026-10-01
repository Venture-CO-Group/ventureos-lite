import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The outbound motor's hard rules, checked against the source (playbook-v6
 * closing audit). Each of these is a promise that a future call site could
 * quietly break; a test that reads the code is what keeps it a promise.
 */
const ROOT = join(__dirname, "..", "..");
const grep = (pattern: string, path = "src") =>
  execSync(`grep -rln -E ${JSON.stringify(pattern)} ${path} || true`, { cwd: ROOT, encoding: "utf8", shell: "/bin/bash" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("no send without an explicit approval of the visible text (rule 6)", () => {
  it("only approveDraft marks an outbound draft APPROVED", () => {
    // A write sets it on its own line inside `data: { … }`; a filter reads it
    // inline in a `where`.
    const writers = grep("outreachDraft\\.(update|updateMany|create)").filter((f) => /^\s+status: "APPROVED",$/m.test(src(f)));
    expect(writers).toEqual(["src/modules/outbound/approval.ts"]);
    expect(src("src/modules/outbound/approval.ts")).toMatch(/decidedById: input\.userId/);
  });
  it("the sender only ever picks up APPROVED drafts", () => {
    expect(src("src/modules/outbound/sender.ts")).toMatch(/where: \{ status: "APPROVED"/);
  });
  it("there is no auto-approve anywhere", () => {
    // Identifiers, not prose: the comments that say "no auto-approve" are fine.
    expect(grep("autoApprove|auto_approve|AUTO_APPROVE", "src")).toEqual([]);
  });
});

describe("cold mail leaves only from the cold identity (rule 11)", () => {
  it("only the outbound sender calls Gmail's raw send, and it asserts the sender first", () => {
    expect(grep("\\.sendRaw\\(").filter((f) => f !== "src/modules/email/gmail.ts")).toEqual(["src/modules/outbound/sender.ts"]);
    const sender = src("src/modules/outbound/sender.ts");
    expect(sender.indexOf("assertColdSender(")).toBeGreaterThan(0);
    expect(sender.indexOf("assertColdSender(")).toBeLessThan(sender.indexOf("gmail.sendRaw("));
  });
  it("the outbound sender imports nothing from the Mailgun campaign sender", () => {
    const imports = src("src/modules/outbound/sender.ts").split("\n").filter((l) => l.startsWith("import"));
    expect(imports.join("\n")).not.toMatch(/campaigns\/send|modules\/mail\/provider|mailgun/i);
  });
});

describe("every registry datasheet is budgeted (rule 12)", () => {
  it("only the registry service calls a provider's detail()", () => {
    const callers = grep("\\bapi\\.detail\\(|\\.detail\\(tax").filter((f) => !f.startsWith("src/modules/registry/cegadat"));
    expect(callers).toEqual(["src/modules/registry/registry-service.ts"]);
  });
});

describe("only true clients are named (rule 13)", () => {
  it("the draft engine reads references only through nameableReferences()", () => {
    const engine = src("src/modules/outbound/draft-engine.ts");
    expect(engine).toMatch(/nameableReferences\(view\.references\)/);
    expect(engine).not.toMatch(/nameableReferences:\s*view\.references/);
  });
});

describe("the hook gate runs before any Claude call (rules 3, 10)", () => {
  it("checks hasHook before calling the model", () => {
    const engine = src("src/modules/outbound/draft-engine.ts");
    expect(engine.indexOf("hasHook(facts)")).toBeGreaterThan(0);
    expect(engine.indexOf("hasHook(facts)")).toBeLessThan(engine.indexOf("await claude("));
  });
});

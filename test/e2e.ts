// End-to-end proof of the non-AI foundation: snapshot a working tree with
// uncommitted changes, apply a buggy change, fork control and candidate, run
// probes through a real browser, and check the verdicts and evidence.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { killAllServers } from "../src/env.ts";
import { exec, ExecError } from "../src/exec.ts";
import { loadProbes, parseProbe } from "../src/probe.ts";
import { parseContract } from "../src/contract.ts";
import { exitCode, renderReport } from "../src/report.ts";
import { readBaseline, recordBaseline } from "../src/snapshot.ts";
import { verify, type ProbeResult, type RunReport, type Verdict } from "../src/verify.ts";
import { copyDemoShop, fixtures, shopProbes } from "./support.ts";

const buggyPatch = path.join(fixtures, "coupons-buggy.patch");

async function main() {
  const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-e2e-")));
  const repo = path.join(sandbox, "shop");
  const home = path.join(sandbox, "home");
  const git = (...args: string[]) => exec("git", args, { cwd: repo });

  try {
    await copyDemoShop(repo);

    // HEAD is committed with a broken checkout form; the fix exists only as an
    // uncommitted edit. A baseline taken from HEAD would make the guest
    // checkout probe fail on control and be discarded.
    const form = path.join(repo, "components", "CheckoutForm.tsx");
    const working = await fs.readFile(form, "utf8");
    assert.ok(working.includes('data-testid="checkout-email"'));
    await fs.writeFile(form, working.replace('data-testid="checkout-email"', 'data-testid="checkout-email-old"'));
    await git("init", "--quiet");
    await git("add", "--all");
    await git("-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "commit", "--quiet", "-m", "initial");
    await fs.writeFile(form, working);

    await recordBaseline(repo);
    await git("apply", buggyPatch);

    const probes = await loadProbes([shopProbes, path.join(fixtures, "probes")]);
    const started = Date.now();
    const report = await verify({ repo, app: ".", probes, home, progress: (message) => console.error(message) });
    console.log(renderReport(report, false));
    console.error(`verify took ${((Date.now() - started) / 1000).toFixed(1)}s`);

    assert.equal(report.outcome, "completed");
    if (report.outcome !== "completed") return;
    const byId = new Map(report.results.map((result) => [result.probe.id, result]));
    const result = (id: string): ProbeResult => {
      const found = byId.get(id);
      assert.ok(found, `no result for probe ${id}`);
      return found;
    };

    // The change guards /checkout behind a session, so every probe that takes
    // a guest there diverges; only the signed-in flow still holds.
    const expected: Record<string, Verdict> = {
      "guest-checkout": "diverged",
      "authenticated-checkout": "held",
      "cart-quantity-change": "diverged",
      "invalid-email-rejected": "diverged",
      "empty-cart-checkout": "diverged",
      "broken-probe": "discarded",
      "coupon-total-consistency": "candidate-only-failed",
    };
    const actual = Object.fromEntries(report.results.map((r) => [r.probe.id, r.verdict]));
    assert.deepEqual(actual, expected);

    // Guest checkout: an order before the change, a redirect to /login after it.
    const guest = result("guest-checkout");
    assert.equal(guest.control?.evidence.ui.url, "/order/1");
    assert.equal(guest.candidate?.evidence.ui.url, "/login");
    const guestOrders = guest.candidate?.evidence.db.orders;
    assert.ok(guestOrders && "added" in guestOrders && guestOrders.added.length === 0);
    assert.deepEqual(
      guest.differences.find((difference) => difference.path === "ui.url"),
      { path: "ui.url", control: "/order/1", candidate: "/login" },
    );
    assert.match(guest.candidate?.stepFailure?.message ?? "", /no usable "checkout-email" element within 2s on \/login/);

    // The signed-in flow passes on both sides, yet the stored order row gained
    // a column: a change that is observed without being a failure.
    assert.deepEqual(
      result("authenticated-checkout").differences.map((difference) => difference.path),
      ["db.orders.added[0].coupon_code"],
    );
    assert.ok(guest.candidate?.screenshot && (await fs.stat(guest.candidate.screenshot)).size > 0);

    // Coupon: $72.00 on screen, 8000 cents in the database and the API response.
    const coupon = result("coupon-total-consistency");
    assert.equal(coupon.control, null);
    assert.equal(coupon.candidate?.evidence.ui.captures.checkoutTotal, 7200);
    const couponOrders = coupon.candidate?.evidence.db.orders;
    assert.ok(couponOrders && "added" in couponOrders);
    assert.equal((couponOrders.added[0] as { total_cents: number }).total_cents, 8000);
    assert.deepEqual(
      coupon.candidate?.expectations.map((e) => e.ok),
      [true, false, true],
    );

    assert.equal(exitCode(report), 1);

    // The exact same candidate has different obligations under explicit tasks.
    const contract = parseContract({ schemaVersion: 1, title: "Require login at checkout", requirements: [
      { id: "checkout-access", kind: "change", description: "Guests visiting checkout are redirected to login" },
    ], exclusions: ["Coupon pricing"] });
    const loginProbe = parseProbe({ id: "login-required", title: "Checkout redirects guests to login", requirementId: "checkout-access",
      steps: [{ do: "goto", path: "/checkout" }], expect: [{ path: "ui.url", equals: "/login" }] }, "test");
    const intended = await verify({ repo, app: ".", probes: [loginProbe], contract, home });
    assert.equal(intended.outcome, "completed");
    assert.equal(exitCode(intended), 0);
    if (intended.outcome !== "completed") assert.fail("expected requested behavior to be fulfilled");
    assert.equal(intended.assessment?.requirements[0]?.probes[0]?.decision, "fulfilled");
    assert.equal(intended.results[0]?.control?.status, "fail");
    assert.equal(intended.results[0]?.candidate?.status, "pass");
    const intendedHtml = await fs.readFile(path.join(intended.runDir, "report.html"), "utf8");
    assert.match(intendedHtml, /Task requirements met by the checked probes/);
    assert.doesNotMatch(intendedHtml, /probe is wrong|Verification inconclusive/);
    const preserve = parseContract({ ...contract, title: "Keep guest checkout", requirements: [
      { id: "checkout-access", kind: "preserve", description: "Guests can still complete checkout" },
    ] });
    const preserved = await verify({ repo, app: ".", probes: [{ ...guest.probe, requirementId: "checkout-access" }], contract: preserve, home });
    assert.equal(exitCode(preserved), 1);
    if (preserved.outcome !== "completed") assert.fail("expected a preservation regression");
    assert.equal(preserved.assessment?.requirements[0]?.probes[0]?.decision, "regression");
    const uncovered = parseContract({ ...contract, requirements: [...contract.requirements,
      { id: "signed-in-checkout", kind: "preserve", description: "Signed-in checkout keeps working" },
    ] });
    const missing = await verify({ repo, app: ".", probes: [loginProbe], contract: uncovered, home });
    assert.equal(missing.outcome, "inconclusive");
    assert.equal(exitCode(missing), 3);

    // The run leaves a self-contained report page with the screenshots embedded.
    const page = await fs.readFile(path.join(report.runDir, "report.html"), "utf8");
    assert.match(page, /4 probes passed before the change and fail after it\./);
    assert.match(page, /4 probes now end on <code>\/login<\/code>/);
    assert.ok((page.match(/src="data:image\/png;base64,/g) ?? []).length >= 9, "screenshots are not embedded");

    // Same baseline, same candidate: both environments come from the cache.
    const again = await verify({ repo, app: ".", probes: probes.slice(0, 1), home });
    assert.equal(again.outcome, "completed");
    if (again.outcome === "completed") assert.deepEqual(again.reused, { control: true, candidate: true });

    // A run with only a broken probe has no usable result, but retains its artifacts.
    const inconclusive = await verify({ repo, app: ".", probes: [result("broken-probe").probe], home });
    assert.equal(inconclusive.outcome, "inconclusive");
    assert.equal(exitCode(inconclusive), 3);
    if (inconclusive.outcome === "inconclusive") {
      assert.deepEqual(inconclusive.results.map((r) => r.verdict), ["discarded"]);
      const saved = JSON.parse(await fs.readFile(path.join(inconclusive.runDir, "report.json"), "utf8"));
      assert.equal(saved.outcome, "inconclusive");
      assert.equal(saved.results[0].control.status, "fail");
      const html = await fs.readFile(path.join(inconclusive.runDir, "report.html"), "utf8");
      assert.match(html, /<h1>Verification inconclusive\.<\/h1>/);
      assert.doesNotMatch(html, /No counterexample discovered/);
    }

    // Direct API callers can supply no probes; that must not report success either.
    const empty = await verify({ repo, app: ".", probes: [], home });
    assert.equal(empty.outcome, "inconclusive");
    assert.equal(exitCode(empty), 3);

    // Reverting the change makes the working tree identical to the baseline.
    await git("apply", "--reverse", buggyPatch);
    assert.equal((await verify({ repo, app: ".", probes, home })).outcome, "unchanged");
    const unimplemented = await verify({ repo, app: ".", probes: [loginProbe], contract, home });
    assert.equal(exitCode(unimplemented), 1, "unchanged code must not fulfill an unimplemented request");

    // Current sources and baseline are fixed. Replay must still reproduce the
    // retained guest regression, using the original contract and probe inputs.
    const movedBaseline = await recordBaseline(repo);
    const indexBefore = (await git("write-tree")).stdout;
    assert.ok(preserved.bundle);
    let replayed: RunReport;
    try {
      await exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "replay", "--bundle", preserved.bundle.path, "--json"], { env: { ...process.env, COUNTERPATCH_HOME: home } });
      assert.fail("replaying the retained regression must exit 1");
    } catch (error) {
      assert.ok(error instanceof ExecError);
      assert.equal(error.code, 1);
      replayed = JSON.parse(error.stdout);
    }
    assert.equal(replayed.outcome, "completed");
    assert.deepEqual(replayed.baseline, preserved.baseline);
    assert.deepEqual(replayed.assessment?.contract, preserve);
    assert.equal(replayed.assessment?.requirements[0]?.probes[0]?.decision, "regression");
    assert.equal(replayed.results[0]?.control?.evidence.ui.url, "/order/1");
    assert.equal(replayed.results[0]?.candidate?.evidence.ui.url, "/login");
    assert.deepEqual(replayed.reused, { control: false, candidate: false });
    assert.equal(replayed.replay?.sourceBundle.sha256, preserved.bundle.sha256);
    assert.notEqual(replayed.runDir, preserved.runDir);
    assert.deepEqual(await readBaseline(repo), movedBaseline);
    assert.equal((await git("write-tree")).stdout, indexBefore);
    assert.equal(await fs.readFile(form, "utf8"), working);
    const replayHtml = await fs.readFile(path.join(replayed.runDir, "report.html"), "utf8");
    assert.match(replayHtml, /Replay of/);
    assert.match(replayHtml, /Task requirements not met/);
    const replayBundle = JSON.parse(await fs.readFile(replayed.bundle!.path, "utf8"));
    assert.equal(replayBundle.execution.preparation, "fresh");
    assert.equal(replayBundle.replayOf.sha256, preserved.bundle.sha256);

    console.log("e2e: PASS");
  } finally {
    killAllServers();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

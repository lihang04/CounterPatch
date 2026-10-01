// End-to-end proof of the non-AI foundation: snapshot a working tree with
// uncommitted changes, apply a buggy change, fork control and candidate, run
// probes through a real browser, and check the verdicts and evidence.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloneDir, killAllServers } from "../src/env.ts";
import { exec } from "../src/exec.ts";
import { loadProbes } from "../src/probe.ts";
import { exitCode, renderReport } from "../src/report.ts";
import { recordBaseline } from "../src/snapshot.ts";
import { verify, type ProbeResult, type Verdict } from "../src/verify.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const demoApp = path.join(projectRoot, "demo-app");
const SKIP = new Set(["node_modules", ".next", "data", "next-env.d.ts", "tsconfig.tsbuildinfo"]);

async function main() {
  const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "counterpatch-e2e-")));
  const repo = path.join(sandbox, "shop");
  const home = path.join(sandbox, "home");
  const git = (...args: string[]) => exec("git", args, { cwd: repo });

  try {
    assert.ok(
      await fs.stat(path.join(demoApp, "node_modules")).catch(() => null),
      'demo-app/node_modules is missing; run "npm install" in demo-app first.',
    );
    await fs.cp(demoApp, repo, { recursive: true, filter: (source) => !SKIP.has(path.basename(source)) });
    await cloneDir(path.join(demoApp, "node_modules"), path.join(repo, "node_modules"));

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
    await git("apply", path.join(here, "fixtures", "coupons-buggy.patch"));

    const probes = await loadProbes([path.join(projectRoot, "probes", "shop"), path.join(here, "fixtures", "probes")]);
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

    // Same baseline, same candidate: both environments come from the cache.
    const again = await verify({ repo, app: ".", probes: probes.slice(0, 1), home });
    assert.equal(again.outcome, "completed");
    if (again.outcome === "completed") assert.deepEqual(again.reused, { control: true, candidate: true });

    // Reverting the change makes the working tree identical to the baseline.
    await git("apply", "--reverse", path.join(here, "fixtures", "coupons-buggy.patch"));
    assert.equal((await verify({ repo, app: ".", probes, home })).outcome, "unchanged");

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

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkExpectation, diffEvidence, parseMoney, parsePath, resolvePath, type Evidence } from "../../src/evidence.ts";
import { parseProbe } from "../../src/probe.ts";

const evidence: Evidence = {
  ui: { url: "/order/1", captures: { total: 7200 } },
  network: {
    calls: [],
    last: {
      "POST /api/orders": { method: "POST", path: "/api/orders", status: 201, requestBody: null, responseBody: { totalCents: 8000 } },
    },
  },
  db: { orders: { rows: [{ id: 1, total_cents: 8000, user_id: null }], added: [{ id: 1, total_cents: 8000, user_id: null }], removed: [] } },
};

test("paths address nested, indexed and quoted keys", () => {
  assert.deepEqual(parsePath('network.last["POST /api/orders"].status'), ["network", "last", "POST /api/orders", "status"]);
  assert.deepEqual(parsePath("db.orders.added[0].total_cents"), ["db", "orders", "added", "0", "total_cents"]);
  assert.deepEqual(resolvePath(evidence, 'network.last["POST /api/orders"].status'), { found: true, value: 201 });
  assert.deepEqual(resolvePath(evidence, "db.orders.added.length"), { found: true, value: 1 });
  assert.deepEqual(resolvePath(evidence, "db.orders.added[0].user_id"), { found: true, value: null });
  assert.deepEqual(resolvePath(evidence, "db.orders.added[3].id"), { found: false });
  assert.deepEqual(resolvePath(evidence, "db.constructor"), { found: false });
  assert.throws(() => parsePath("db..orders"), /Invalid evidence path/);
  assert.throws(() => parsePath("db.orders["), /Invalid evidence path/);
});

test("expectations compare against literals, patterns and other evidence", () => {
  const probe = parseProbe(
    {
      id: "p",
      title: "p",
      steps: [{ do: "goto", path: "/" }],
      expect: [
        { path: "ui.url", matches: "^/order/\\d+$" },
        { path: "db.orders.added[0].user_id", equals: null },
        { path: "ui.captures.total", equalsPath: "db.orders.added[0].total_cents" },
        { path: "db.refunds.added.length", equals: 0 },
      ],
    },
    "inline",
  );
  const [url, guest, consistent, missing] = probe.expect.map((e) => checkExpectation(evidence, e));
  assert.equal(url?.ok, true);
  assert.equal(guest?.ok, true);
  assert.equal(consistent?.ok, false);
  assert.match(consistent?.message ?? "", /is 7200, db\.orders\.added\[0\]\.total_cents is 8000/);
  assert.equal(missing?.ok, false);
  assert.match(missing?.message ?? "", /was not observed/);
});

test("probes are rejected unless each expectation has exactly one comparison", () => {
  const base = { id: "p", title: "p", steps: [{ do: "goto", path: "/" }] };
  assert.throws(() => parseProbe({ ...base, expect: [{ path: "ui.url" }] }, "inline"), /Exactly one/);
  assert.throws(() => parseProbe({ ...base, expect: [{ path: "ui.url", equals: 1, matches: "x" }] }, "inline"), /Exactly one/);
  assert.throws(() => parseProbe({ ...base, steps: [{ do: "evaluate", script: "1" }], expect: [] }, "inline"), /invalid/);
});

test("evidence differences are reported per leaf", () => {
  const candidate = structuredClone(evidence);
  candidate.ui.url = "/login";
  candidate.db.orders = { rows: [], added: [], removed: [] };
  assert.deepEqual(diffEvidence(evidence, evidence), []);
  const paths = diffEvidence(evidence, candidate).map((d) => d.path);
  assert.deepEqual(paths, ["db.orders.added[0]", "db.orders.rows[0]", "ui.url"]);
});

test("money is parsed to integer cents", () => {
  assert.equal(parseMoney("$72.00"), 7200);
  assert.equal(parseMoney(" $1,072.50 "), 107250);
  assert.equal(parseMoney("$0.07"), 7);
  assert.equal(parseMoney("-$5.00"), -500);
  assert.equal(parseMoney("19"), 1900);
  assert.equal(parseMoney("$72.5"), null);
  assert.equal(parseMoney("free"), null);
  assert.equal(parseMoney(""), null);
});

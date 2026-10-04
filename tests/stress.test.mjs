// Randomized checks: hundreds of generated bills, receipts and sync
// interleavings, asserting the things that must always hold.
import test from "node:test";
import assert from "node:assert/strict";
import { computeSplit, findIssues } from "../js/split.js";
import { parseReceipt } from "../js/parse.js";
import { Room } from "../js/sync.js";

// Small seeded PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pick = (r, a) => a[Math.floor(r() * a.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const sum = (a) => a.reduce((x, y) => x + y, 0);

function randomBill(r) {
  const people = Array.from({ length: int(r, 1, 8) }, (_, i) => ({ id: "p" + i }));
  const items = Array.from({ length: int(r, 1, 25) }, (_, i) => {
    const qty = r() < 0.25 ? int(r, 2, 6) : 1;
    return { id: "i" + i, name: "Item " + i, qty, price: int(r, 1, 9000) * (r() < 0.3 ? qty : 1), shared: r() < 0.2 };
  });
  const claims = {};
  const portions = {};
  for (const it of items) {
    if (r() < 0.1) continue; // unclaimed
    const c = (claims[it.id] = {});
    for (const p of people) if (r() < 0.35) c[p.id] = int(r, 1, it.qty);
    if (!Object.keys(c).length) c[pick(r, people).id] = 1;
    if (r() < 0.15) {
      const ids = Object.keys(c);
      portions[it.id] = { [pick(r, ids)]: pick(r, [0.25, 1 / 3, 0.5, 2 / 3, 0.75]) };
    }
  }
  const tip = r() < 0.5
    ? { mode: "percent", percent: pick(r, [0, 15, 18, 20, 22.5, 25, 100]), base: pick(r, ["pretax", "posttax"]), split: pick(r, ["proportional", "even"]) }
    : { mode: "amount", amount: int(r, 0, 9999), split: pick(r, ["proportional", "even"]) };
  const fees = r() < 0.4 ? [{ amount: int(r, -2000, 1500) }] : [];
  const covered = r() < 0.2 && people.length > 1 ? [pick(r, people).id] : [];
  return { people, items, claims, portions, tax: int(r, 0, 3000), fees, tip, covered, payer: pick(r, people).id };
}

test("2000 random bills: totals add up exactly and every row is consistent", () => {
  for (let seed = 1; seed <= 2000; seed++) {
    const bill = randomBill(rng(seed));
    const res = computeSplit(bill);
    const msg = `seed ${seed}`;
    assert.equal(sum(res.rows.map((x) => x.total)), res.grandTotal, msg);
    assert.equal(res.grandTotal, res.subtotal + res.tax + res.feesTotal + res.tipTotal, msg);
    for (const row of res.rows) {
      assert.ok(Number.isInteger(row.total), msg);
      assert.equal(row.food + row.tax + row.fees + row.tip + row.cover, row.total, msg);
    }
    for (const id of bill.covered) assert.equal(res.rows.find((x) => x.id === id).total, 0, msg);
    for (const i of findIssues(bill.items, bill.people, bill.claims, bill.portions)) {
      assert.ok(["unclaimed", "over", "share-over", "share-under"].includes(i.type), msg);
    }
  }
});

test("people with identical orders pay within a cent, the payer taking any extra", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const r = rng(seed * 7);
    const n = int(r, 2, 8);
    const people = Array.from({ length: n }, (_, i) => ({ id: "p" + i }));
    const items = Array.from({ length: int(r, 1, 10) }, (_, i) => ({ id: "i" + i, name: "x", qty: 1, price: int(r, 1, 7777), shared: true }));
    const everyone = Object.fromEntries(people.map((p) => [p.id, 1]));
    const claims = Object.fromEntries(items.map((it) => [it.id, everyone]));
    const payer = pick(r, people).id;
    const res = computeSplit({ items, people, claims, tax: int(r, 0, 999), fees: [{ amount: int(r, 0, 500) }], tip: { mode: "percent", percent: pick(r, [15, 18, 20]), base: "pretax", split: "proportional" }, payer });
    const totals = res.rows.map((x) => x.total);
    assert.ok(Math.max(...totals) - Math.min(...totals) <= 1, `seed ${seed}: ${totals}`);
    assert.equal(res.rows.find((x) => x.id === payer).total, Math.max(...totals), `seed ${seed}`);
  }
});

test("receipt formats from different restaurants and printers", () => {
  const cases = [
    {
      text: `THE CORNER TAVERN
1 Burger 14.99
1 Fries 4.50
2 IPA @ 7.00 14.00
SUBTOTAL 33.49
TAX 2.68
TOTAL 36.17`,
      items: [["Burger", 1, 1499], ["Fries", 1, 450], ["Ipa", 2, 1400]], subtotal: 3349, tax: 268, total: 3617,
    },
    {
      text: `Cafe Lumen
Latte $5.25
Croissant $4.00
Avocado Toast $12.50
Discount -$2.00
Sub-total $19.75
Sales Tax (8%) $1.58
Total Due $21.33`,
      items: [["Latte", 1, 525], ["Croissant", 1, 400], ["Avocado Toast", 1, 1250]], subtotal: 1975, tax: 158, total: 2133, fees: [-200],
    },
    {
      text: `SUSHI KO
Salmon Roll 8,50
Edamame 5,00
Miso Soup 3,50
Subtotal 17,00
VAT 3,40
Service charge 12% 2,04
Total 22,44`,
      items: [["Salmon Roll", 1, 850], ["Edamame", 1, 500], ["Miso Soup", 1, 350]], subtotal: 1700, tax: 340, total: 2244, fees: [204],
    },
    {
      text: `Taqueria Sol    (267) 555-0199
3 x Al Pastor Taco 10.50
Horchata 3.75
Chips & Salsa 4.00
SUBTTL 18.25
TAX 1.46
Gratuity Added 3.29
TOTAL 22.99
MASTERCARD ****4421 22.99
CHANGE DUE 0.00`,
      items: [["Al Pastor Taco", 3, 1050], ["Horchata", 1, 375], ["Chips & Salsa", 1, 400]], subtotal: 1825, tax: 146, total: 2299, tip: 329,
    },
  ];
  for (const c of cases) {
    const r = parseReceipt(c.text);
    const name = c.text.split("\n")[0];
    assert.deepEqual(r.items.map((i) => [i.name, i.qty, i.price]), c.items, name);
    assert.equal(r.subtotal, c.subtotal, name);
    assert.equal(r.tax, c.tax, name);
    assert.equal(r.total, c.total, name);
    if (c.fees) assert.deepEqual(r.fees.map((f) => f.amount), c.fees, name);
    if (c.tip) assert.equal(r.tip, c.tip, name);
  }
});

test("parser survives junk without throwing", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed);
    const chars = "abcXYZ0123456789 .,$-:#@*%/\n\t|";
    const text = Array.from({ length: int(r, 0, 600) }, () => pick(r, [...chars])).join("");
    const out = parseReceipt(text);
    for (const it of out.items) {
      assert.ok(it.qty >= 1 && Number.isFinite(it.price) && it.name.length > 0, `seed ${seed}`);
    }
  }
});

// Live sync: phones receive the same messages in different orders and must
// still end up with the same bill.
function envelope(msg) {
  return { data: JSON.stringify({ id: Math.random().toString(36).slice(2), event: "message", message: JSON.stringify(msg) }) };
}

test("live bills converge no matter the delivery order", async () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const phones = Array.from({ length: int(r, 2, 4) }, (_, i) => new Room({ code: "TEST1", clientId: "c" + i }));
    const sent = [];
    let clock = 1000;
    for (let step = 0; step < int(r, 5, 40); step++) {
      const from = pick(r, phones);
      const key = pick(r, ["tip", "payer", "c:i1:p1", "c:i1:p2", "c:i2:p1", "f:i1:p1", "p:p3"]);
      const value = r() < 0.2 ? null : int(r, 0, 9);
      // Phones' clocks disagree a little and sometimes collide exactly.
      const ts = clock + int(r, -3, 3);
      clock += int(r, 0, 2);
      sent.push({ t: "ops", by: from.clientId, ops: [[key, value, ts, from.clientId]] });
    }
    for (const phone of phones) {
      const order = [...sent].sort(() => r() - 0.5);
      for (const m of order) await phone.receive(envelope({ ...m, by: "relay" }));
    }
    const first = JSON.stringify(Object.entries(phones[0].data).sort());
    for (const phone of phones) assert.equal(JSON.stringify(Object.entries(phone.data).sort()), first, `seed ${seed}`);
    phones.forEach((p) => p.close());
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { allocate, computeSplit, findIssues, portionShares } from "../js/split.js";
import { parseReceipt } from "../js/parse.js";

const sum = (a) => a.reduce((x, y) => x + y, 0);

test("allocate always adds up to the cent", () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(sum(allocate(1001, [3.3, 2.1, 7, 0])), 1001);
  assert.deepEqual(allocate(-10, [1, 1]), [-5, -5]);
  assert.deepEqual(allocate(5, [0, 0]), [0, 0]);
  assert.equal(allocate(7, [0, 2, 1])[0], 0);
});

const people = [{ id: "a" }, { id: "b" }, { id: "c" }];
const items = [
  { id: "i1", name: "Pizza", qty: 1, price: 2000, shared: true },
  { id: "i2", name: "Beer", qty: 3, price: 2100 },
  { id: "i3", name: "Salad", qty: 1, price: 1200 },
];
const tip = { mode: "percent", percent: 20, base: "pretax", split: "proportional" };

test("split totals match the bill exactly", () => {
  const claims = { i1: { a: 1, b: 1, c: 1 }, i2: { a: 2, b: 1 }, i3: { c: 1 } };
  const r = computeSplit({ items, people, claims, tax: 470, fees: [{ amount: 300 }], tip });
  assert.equal(r.tipTotal, 1060);
  assert.equal(r.grandTotal, 5300 + 470 + 300 + 1060);
  assert.equal(sum(r.rows.map((x) => x.total)), r.grandTotal);
  assert.equal(r.rows[0].food, Math.round(2000 / 3 + 1400));
});

test("covering someone moves their share to others", () => {
  const claims = { i1: { a: 1, b: 1, c: 1 }, i2: { a: 3 }, i3: { c: 1 } };
  const r = computeSplit({ items, people, claims, tax: 0, tip: { ...tip, percent: 0 }, covered: ["c"] });
  assert.equal(r.rows[2].total, 0);
  assert.equal(sum(r.rows.map((x) => x.total)), r.grandTotal);
});

test("issues flag unclaimed, over and under claims", () => {
  const claims = { i2: { a: 1 }, i3: { a: 1, b: 1 } };
  const types = findIssues(items, people, claims).map((i) => `${i.item.id}:${i.type}`);
  assert.deepEqual(types, ["i1:unclaimed", "i2:under", "i3:over"]);
});

test("parser reads a typical receipt", () => {
  const r = parseReceipt(`TRATTORIA ROMA
123 Main St
Server: Dana  Table 12
2 MARGHERITA PIZZA   32.00
CAESAR SALAD 12.OO
3 x Peroni 21.00
Garlic Bread $7.50
Happy hour discount -5.00
SUBTOTAL 67.50
Sales Tax 5.40
Service charge 3.00
TOTAL 75.90
VISA ****1234 75.90`);
  assert.equal(r.merchant, "Trattoria Roma");
  assert.deepEqual(r.items.map((i) => [i.name, i.qty, i.price]), [
    ["Margherita Pizza", 2, 3200],
    ["Caesar Salad", 1, 1200],
    ["Peroni", 3, 2100],
    ["Garlic Bread", 1, 750],
  ]);
  assert.equal(r.subtotal, 6750);
  assert.equal(r.tax, 540);
  assert.equal(r.total, 7590);
  assert.deepEqual(r.fees.map((f) => f.amount), [-500, 300]);
});

test("portions: fixed shares pay exactly, the rest split evenly", () => {
  const s = portionShares(["a", "b", "c"], { a: 0.5 });
  assert.equal(s.a, 0.5);
  assert.ok(Math.abs(s.b - 0.25) < 1e-9 && Math.abs(s.c - 0.25) < 1e-9);
  const over = portionShares(["a", "b"], { a: 0.75, b: 0.5 });
  assert.ok(Math.abs(over.a + over.b - 1) < 1e-9);
});

test("portions flow through the split and get flagged when they don't fit", () => {
  const pizza = [{ id: "p", name: "Pizza", qty: 1, price: 3000 }];
  const claims = { p: { a: 1, b: 1 } };
  const r = computeSplit({ items: pizza, people, claims, portions: { p: { a: 2 / 3 } }, tip: { ...tip, percent: 0 } });
  assert.equal(r.rows[0].food, 2000);
  assert.equal(r.rows[1].food, 1000);
  assert.equal(sum(r.rows.map((x) => x.total)), 3000);
  assert.deepEqual(findIssues(pizza, people, claims, { p: { a: 2 / 3 } }), []);
  assert.equal(findIssues(pizza, people, claims, { p: { a: 0.75, b: 0.5 } })[0].type, "share-over");
  assert.equal(findIssues(pizza, people, claims, { p: { a: 0.25, b: 0.25 } })[0].type, "share-under");
});

test("people who ordered the same thing pay within a cent, and the payer absorbs ties", () => {
  const six = ["anna", "emily", "mateo", "brandon", "idania", "ben"].map((id) => ({ id }));
  const items = [
    { id: "m", name: "Margherita", qty: 2, price: 5400 },
    { id: "s", name: "Sophia Loren", qty: 1, price: 2800 },
    { id: "c", name: "Panzanella", qty: 1, price: 1400 },
  ];
  // Margherita and salad split by all six; Sophia Loren shared by three.
  const all = Object.fromEntries(six.map((p) => [p.id, 1]));
  const claims = { m: all, c: all, s: { mateo: 1, brandon: 1, ben: 1 } };
  const items2 = items.map((i) => ({ ...i, shared: true }));
  const r = computeSplit({
    items: items2, people: six, claims, tax: 793, fees: [{ amount: 311 }],
    tip: { mode: "amount", amount: 1728, split: "proportional" }, payer: "ben",
  });
  const t = Object.fromEntries(r.rows.map((x) => [x.id, x.total]));
  assert.equal(sum(r.rows.map((x) => x.total)), 12432);
  assert.ok(Math.abs(t.mateo - t.ben) <= 1 && Math.abs(t.brandon - t.ben) <= 1);
  assert.ok(Math.abs(t.anna - t.emily) <= 1);
  assert.ok(t.ben >= t.mateo && t.ben >= t.brandon);
  r.rows.forEach((x) => assert.equal(x.food + x.tax + x.fees + x.tip + x.cover, x.total));
});

test("parser reads a paid receipt: fee, printed tip, and the name beside the phone", () => {
  const r = parseReceipt(`Date: 10/3/26          Time: 6:42 pm
Pizzata                 215-546-7200
To Go                          #525
Customer Name:                Ben G
2 Size Queen Margherita      $54.00
Size Sophia Loren Pizza      $28.00
Ciao Panzanella Salad        $14.00
Subtotal                     $96.00
Tax                           $7.93
Transaction Processing Fee    $3.11
Tip                          $17.28
Total                       $124.32
CREDIT CARD           AUTHORIZATION
ENTRY                          CHIP
VISA #6115                  $124.32`);
  assert.equal(r.merchant, "Pizzata");
  assert.deepEqual(r.items.map((i) => [i.qty, i.price]), [[2, 5400], [1, 2800], [1, 1400]]);
  assert.equal(r.subtotal, 9600);
  assert.equal(r.tax, 793);
  assert.deepEqual(r.fees.map((f) => f.amount), [311]);
  assert.equal(r.tip, 1728);
  assert.equal(r.total, 12432);
});

test("suggested-tip lines are not a paid tip", () => {
  const r = parseReceipt(`Noodle Bar
Dumplings 10.00
Subtotal 10.00
Suggested tip
18% 1.80
20% 2.00
Total 10.00`);
  assert.equal(r.tip, null);
  assert.equal(r.items.length, 1);
});

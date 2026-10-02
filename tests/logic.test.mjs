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

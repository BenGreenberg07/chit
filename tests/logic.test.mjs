import test from "node:test";
import assert from "node:assert/strict";
import { allocate, computeSplit, findIssues, portionShares } from "../js/split.js";
import { parseReceipt } from "../js/parse.js";
import { withGroup, readGroups, inkForName, knownNames, groupLabel, agoText } from "../js/groups.js";

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

test("issues flag unclaimed and double-claimed lines; partly claimed lines are fine", () => {
  const claims = { i2: { a: 1 }, i3: { a: 1, b: 1 } };
  const types = findIssues(items, people, claims).map((i) => `${i.item.id}:${i.type}`);
  assert.deepEqual(types, ["i1:unclaimed", "i3:over"]);
});

test("a partly claimed line belongs to whoever claimed it", () => {
  const noodles = [{ id: "n", name: "Dan Dan Noodles", qty: 2, price: 2800 }, { id: "b", name: "Pork Buns", qty: 3, price: 1350 }];
  const claims = { n: { a: 1 }, b: { b: 1, c: 1 } };
  const r = computeSplit({ items: noodles, people, claims, tip: { ...tip, percent: 0 } });
  assert.equal(r.rows[0].food, 2800);
  assert.equal(r.rows[1].food + r.rows[2].food, 1350);
  assert.ok(Math.abs(r.rows[1].food - r.rows[2].food) <= 1);
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

// Real reads of a shaded Pizzeria Stella photo: margin specks around every
// line, logo art above the name, and one faded 8 read as a 6.
test("parses a noisy photo of a shaded receipt", () => {
  const reads = [
    `- |\nb or $ 5\nSTESLA Se\n4 % ET ae\nie Pizzeria Stella =\n420 S 2nd Street\nPhiladelphia, PA 19147 | Nog\nserver: Madison G SE\nCheck #5 Table 204 EEE\nGuest Count: 4 T= A\nb ordered: 10/9/26 12:05 PH =H\ni 1 Rigatoni Alla Vodka $21.00 R. —\ni] 2 Pomodoro $36.00 =\nd 1 Margherita $20.00 he a\nig = =. =i\n- Subtotal $79.00 ho,\nTax $6.32 nC —\nTotal $85.32 fa e\nPay with your mobile device at Se\n[ 7 upngo.com/Pizzeriastella v av`,
    `A a | ~ BET ee Pe\n[¥ Pizzeria Stella =\n: 420 S 2nd Street .\ni 1 Rigatoni Alla Vodka $21.00 == ko\n3 2 Pomodoro $38.00 =\nF 1 Margherita $20.00 = y\nEE - Subtotal $79.00 hg"\n5 Tax $6.32 p> =\n| 3 Total $85.32 I e.`,
  ];
  for (const text of reads) {
    const r = parseReceipt(text);
    assert.equal(r.merchant, "Pizzeria Stella");
    assert.deepEqual(r.items.map((i) => [i.name, i.qty, i.price]), [
      ["Rigatoni Alla Vodka", 1, 2100],
      ["Pomodoro", 2, 3800],
      ["Margherita", 1, 2000],
    ]);
    assert.equal(r.subtotal, 7900);
    assert.equal(r.tax, 632);
    assert.equal(r.total, 8532);
    if (/Guest/.test(text)) assert.equal(r.guests, 4);
  }
});

test("only repairs a misread digit when exactly one swap fits", () => {
  // 12.00 + 13.00 should be 30.00: 13 -> 18 fits, and so does 12 -> 17,
  // so neither is changed.
  const r = parseReceipt(`Soup 12.00\nSalad 13.00\nSubtotal 30.00`);
  assert.deepEqual(r.items.map((i) => i.price), [1200, 1300]);
});

// Pizzeria Stella prints each amount half a line above its label, so a sharp
// photo can pair them wrong, split them apart, or lose the tax amount.
test("re-pairs totals printed out of line with their labels", () => {
  const head = "Pizzeria Stella\n420 S 2nd Street\n1 Rigatoni Alla Vodka $21.00\n2 Pomodoro $38.00\n1 Margherita $20.00\n";
  const tails = [
    "$79.00\nSubtotal $6.32\nTax $85.32\nTotal",
    "Subtotal $79.00\n$6.32\nTax\nTotal $85.32",
    "$79.00\nSubtotal\n$6.32\nTax\n$85.32\nTotal",
    "Subtotal $79.00 $6.32\nTax $85.32\nTotal",
    "Subtotal $79.00\nTax\nTotal $85.32",
    "Subtotal $79.00\nTex $6.32\nTotal $85.32",
    "$79.00\nSubtotal $6.32\nTax $85.32\nTotal\nPay with your mobile device at",
  ];
  for (const tail of tails) {
    const r = parseReceipt(head + tail);
    assert.deepEqual([r.subtotal, r.tax, r.total], [7900, 632, 8532], tail);
    assert.equal(r.items.length, 3, tail);
  }
});

test("doesn't invent tax a receipt never printed", () => {
  const r = parseReceipt("Soup 12.00\nSalad 13.00\nSubtotal 25.00\nTotal 31.00");
  assert.equal(r.tax, 0);
});

// ---------- a full table of ten ----------

test("ten people splitting one bill still add up to the cent", () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ id: "p" + i }));
  const items = [
    { id: "a", name: "Family noodles", qty: 1, price: 4499, shared: true },
    { id: "b", name: "Beers", qty: 10, price: 6000 },
    { id: "c", name: "Cake", qty: 1, price: 999, shared: true },
  ];
  const claims = {
    a: Object.fromEntries(people.map((p) => [p.id, 1])),
    b: Object.fromEntries(people.map((p) => [p.id, 1])),
    c: { p0: 1, p1: 1, p2: 1 },
  };
  const res = computeSplit({
    items, people, claims,
    tax: 937, fees: [{ id: "f", name: "Service", amount: 1500 }],
    tip: { mode: "percent", percent: 20, base: "pretax", split: "proportional" },
    payer: "p3",
  });
  assert.equal(res.rows.length, 10);
  assert.equal(res.rows.reduce((a, r) => a + r.total, 0), res.grandTotal);
  // The three who had cake pay more than the seven who didn't.
  const cake = res.rows.filter((r) => ["p0", "p1", "p2"].includes(r.id)).map((r) => r.total);
  const none = res.rows.filter((r) => !["p0", "p1", "p2"].includes(r.id)).map((r) => r.total);
  assert.ok(Math.min(...cake) > Math.max(...none));
  assert.equal(findIssues(items, people, claims).length, 0);
});

test("a ten-person table leaves no line looking unclaimed", () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ id: "p" + i }));
  const items = [{ id: "a", name: "Platter", qty: 1, price: 5000, shared: true }];
  // Nine of ten claimed it: still one line, still fully paid, no issue raised.
  const claims = { a: Object.fromEntries(people.slice(0, 9).map((p) => [p.id, 1])) };
  assert.deepEqual(findIssues(items, people, claims), []);
  const res = computeSplit({ items, people, claims, tax: 0, fees: [], tip: { mode: "amount", amount: 0 }, payer: "p0" });
  assert.equal(res.rows.find((r) => r.id === "p9").total, 0);
  assert.equal(res.rows.reduce((a, r) => a + r.total, 0), 5000);
});

// ---------- remembered tables ----------

test("the same people are one remembered table, however the names are typed", () => {
  let list = [];
  list = withGroup(list, [{ name: "Ben", ink: "#1" }, { name: "Mia", ink: "#2" }], 1000, "g1");
  list = withGroup(list, [{ name: " mia " }, { name: "BEN" }], 2000, "g2");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "g1", "it stays the same table, moved to the front");
  assert.equal(list[0].at, 2000);
  // Names refresh so a correction sticks; pens carry over when none are given.
  assert.deepEqual(list[0].people.map((p) => p.name), ["mia", "BEN"]);
  assert.deepEqual(list[0].people.map((p) => p.ink), ["#2", "#1"]);
});

test("a different table is a different group, newest first and capped", () => {
  let list = [];
  for (let i = 0; i < 15; i++) {
    list = withGroup(list, [{ name: "A" + i }, { name: "B" + i }], 1000 + i, "g" + i);
  }
  assert.equal(list.length, 12);
  assert.equal(list[0].id, "g14");
  assert.ok(list.every((g, i, a) => i === 0 || a[i - 1].at > g.at));
});

test("a table of one isn't a group", () => {
  assert.deepEqual(withGroup([], [{ name: "Ben" }], 1), []);
  assert.deepEqual(withGroup([], [{ name: "Ben" }, { name: "  " }], 1), []);
});

test("remembers each person's pen and every name it has seen", () => {
  let list = [];
  list = withGroup(list, [{ name: "Ben", ink: "#B" }, { name: "Mia", ink: "#M" }], 1000, "g1");
  list = withGroup(list, [{ name: "Theo", ink: "#T" }, { name: "Ben", ink: "#B2" }], 2000, "g2");
  assert.equal(inkForName("ben", list), "#B2", "the most recent table wins");
  assert.equal(inkForName("MIA", list), "#M");
  assert.equal(inkForName("nobody", list), undefined);
  assert.deepEqual(knownNames(list), ["Theo", "Ben", "Mia"]);
});

test("reads a table back the way someone would say it", () => {
  const g = (names) => ({ id: "x", key: "k", at: 0, people: names.map((n) => ({ name: n })) });
  assert.equal(groupLabel(g(["Ben", "Mia"])), "Ben and Mia");
  assert.equal(groupLabel(g(["Ben", "Mia", "Theo"])), "Ben, Mia and Theo");
  assert.equal(groupLabel(g(["Ben", "Mia", "Theo", "Ada"])), "Ben, Mia and 2 more");
  const day = 86400000;
  assert.equal(agoText(5000, 5000), "today");
  assert.equal(agoText(0, day + 1), "yesterday");
  assert.equal(agoText(0, 4 * day), "4 days ago");
  assert.equal(agoText(0, 9 * day), "last week");
  assert.equal(agoText(0, 21 * day), "3 weeks ago");
  assert.equal(agoText(0, 400 * day), "over a year ago");
});

test("a half-written group store doesn't take the Table step down", () => {
  const fake = (raw) => ({ getItem: () => raw, setItem() {} });
  for (const raw of ["", "{", "null", '{"not":"a list"}', '[{"id":"x"}]', '[{"id":"x","key":"k","at":1,"people":[{"name":""},{"name":"B"}]}]']) {
    assert.deepEqual(readGroups(fake(raw)), [], raw);
  }
  assert.equal(readGroups(fake('[{"id":"x","key":"k","at":1,"people":[{"name":"A"},{"name":"B"}]}]')).length, 1);
});

test("a discount bigger than the bill still adds up, and nobody's share vanishes", () => {
  // A $60 gift card against $40 of food: the table is owed money, and that
  // refund has to land on people instead of disappearing.
  const two = [{ id: "a" }, { id: "b" }];
  const food = [{ id: "i1", name: "Pasta", qty: 1, price: 2500, shared: false },
                { id: "i2", name: "Soup", qty: 1, price: 1500, shared: false }];
  const r = computeSplit({
    items: food, people: two, claims: { i1: { a: 1 }, i2: { b: 1 } },
    tax: 0, fees: [{ id: "g", name: "Gift card", amount: -6000 }],
    tip: { mode: "amount", amount: 0 }, payer: "a",
  });
  assert.equal(r.grandTotal, -2000);
  assert.equal(sum(r.rows.map((x) => x.total)), r.grandTotal);
  // Whoever ordered more of the food is owed more of what's left over.
  assert.ok(r.rows[0].total < r.rows[1].total);
  for (const row of r.rows) assert.equal(row.food + row.tax + row.fees + row.tip + row.cover, row.total);
});

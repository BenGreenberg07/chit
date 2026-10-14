// Randomized checks: hundreds of generated bills, receipts and sync
// interleavings, asserting the things that must always hold.
import test from "node:test";
import assert from "node:assert/strict";
import { computeSplit, findIssues } from "../js/split.js";
import { parseReceipt, textFromWords } from "../js/parse.js";
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

// Places a line's words the way the reader reports them: a margin speck far
// left, words a space apart, the price out at the right edge, then a scrap.
function layOut(r, { before, line, after }) {
  const words = [];
  let x = int(r, 0, 30);
  const put = (text) => { const w = text.length * 18; words.push({ text, bbox: { x0: x, x1: x + w } }); x += w; };
  if (before) { put(before); x += int(r, 110, 400); }
  const parts = line.split(" ");
  const priced = /\d\.\d\d$/.test(parts.at(-1));
  parts.forEach((p, k) => {
    if (k) x += priced && k === parts.length - 1 ? int(r, 150, 600) : int(r, 16, 28);
    put(p);
  });
  if (after) for (const p of after.split(" ")) { x += int(r, 80, 400); put(p); }
  return { words };
}

// Photo noise like the shaded Pizzeria Stella shot: specks in the margins on
// both sides of each line, junk lines from the table and logo, and now and
// then one faded digit. The parser must recover every line exactly, or, when
// a faded digit can't be pinned down, leave the lines visibly off the
// subtotal so the receipt check flags it.
const DISHES = ["Rigatoni Alla Vodka", "Pomodoro", "Margherita", "Pad See Ew", "BLT Club", "Caesar Salad",
  "Chicken Parm", "Fish Tacos", "Spicy Wontons", "Garlic Knots", "Cacio e Pepe", "Iced Tea", "Pinot Noir",
  "Lamb Burger", "Tuna Tartare", "Mushroom Risotto", "Short Rib", "Kids Mac", "Draft IPA", "Espresso"];
const PLACES = ["Pizzeria Stella", "Noodle Bar", "The Corner Tavern", "Luna Rossa", "Golden Dragon", "Cafe Mia"];
const LEAD = ["i", "|", "[", "i]", "id", "F", "ir", "-", ":", "{", "b", "y", "ig", "\\"];
// Specks that read as digits look exactly like a quantity in plain text, so
// they only appear in the word-position runs, where their distance gives
// them away.
const DIGIT_LEAD = ["3", "5", "1", "8"];
const TAIL = ["bo \\", "=", "8 Ke hc", "R. —", "he a", "ho,", "nC —", "3 ew.", "0", 'hg"', "p> =", "fa e", "| Nog", "SEE"];
const JUNK = ["- |", "b or $ 5", "STESLA Se", "4 % ET ae", "A a | ~ BET ee Pe", "ig = =. =i", "/A = Be 5 8 ~ .", "NE hy", "\\ Seed ke ne"];
const LOOK = { 0: "689", 1: "47", 2: "7", 3: "589", 4: "19", 5: "368", 6: "058", 7: "12", 8: "03569", 9: "0348" };
const money = (c) => "$" + (c / 100).toFixed(2);

test("parser recovers receipts through photo noise", () => {
  let repaired = 0;
  let flagged = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    // Odd seeds go through word positions like the reader returns; even
    // seeds are plain text.
    const placed = seed % 2 === 1;
    const lead = () => pick(r, placed && r() < 0.4 ? DIGIT_LEAD : LEAD);
    const rows = [];
    const noisy = (line) => {
      const before = r() < 0.6 ? lead() : "";
      const after = r() < 0.6 ? pick(r, TAIL) : "";
      rows.push({ before, line, after });
      return [before, line, after].filter(Boolean).join(" ");
    };
    const place = pick(r, PLACES);
    const items = Array.from({ length: int(r, 1, 9) }, () => {
      const qty = r() < 0.3 ? int(r, 2, 4) : 1;
      return { name: pick(r, DISHES), qty, price: int(r, 3, 60) * 100 * qty + pick(r, [0, 0, 50, 25, 99]) };
    });
    const sub = sum(items.map((i) => i.price));
    const tax = Math.round(sub * 0.08);
    const lines = [];
    const junk = () => { const j = pick(r, JUNK); rows.push({ before: "", line: j, after: "" }); return j; };
    for (let k = int(r, 0, 4); k > 0; k--) lines.push(junk());
    lines.push(noisy(place), noisy(`${int(r, 10, 9999)} S ${int(r, 1, 40)}th Street`), noisy("Philadelphia, PA 19147"));
    lines.push(noisy(`Server: Madison G`), noisy(`Check #${int(r, 1, 99)} Table ${int(r, 1, 300)}`), noisy(`Guest Count: ${int(r, 1, 9)}`));
    // A faded digit in one price, sometimes.
    const printed = items.map((i) => i.price);
    let faded = -1;
    if (r() < 0.35) {
      faded = int(r, 0, items.length - 1);
      const d = String(printed[faded]);
      const at = int(r, 0, d.length - 1);
      // A leading digit never fades to 0; that would just shorten the price.
      const alts = [...LOOK[d[at]]].filter((c) => at > 0 || c !== "0");
      printed[faded] = Number(d.slice(0, at) + pick(r, alts) + d.slice(at + 1));
    }
    items.forEach((it, k) => {
      lines.push(noisy(`${it.qty > 1 || r() < 0.5 ? it.qty + " " : ""}${it.name} ${money(printed[k])}`));
      if (r() < 0.2) lines.push(junk());
    });
    // Or one faded digit in the subtotal, tax or total instead.
    const sums = [sub, tax, sub + tax];
    if (faded < 0 && r() < 0.3) {
      const k = int(r, 0, 2);
      const d = String(sums[k]);
      const at = int(r, 0, d.length - 1);
      const alts = [...LOOK[d[at]]].filter((c) => at > 0 || c !== "0");
      sums[k] = Number(d.slice(0, at) + pick(r, alts) + d.slice(at + 1));
    }
    // Printers that set amounts half a line above their labels, read back
    // paired wrong, split apart, or with the tax amount lost.
    const labs = ["Subtotal", "Tax", "Total"];
    const amts = sums.map(money);
    const style = sums[1] === tax && sums[0] === sub && sums[2] === sub + tax ? pick(r, ["inline", "inline", "shifted", "split", "lost"]) : "inline";
    if (style === "inline") labs.forEach((l, k) => lines.push(noisy(`${l} ${amts[k]}`)));
    if (style === "shifted") lines.push(noisy(amts[0]), noisy(`${labs[0]} ${amts[1]}`), noisy(`${labs[1]} ${amts[2]}`), noisy(labs[2]));
    if (style === "split") labs.forEach((l, k) => lines.push(noisy(amts[k]), noisy(l)));
    if (style === "lost") lines.push(noisy(`${labs[0]} ${amts[0]}`), noisy(labs[1]), noisy(`${labs[2]} ${amts[2]}`));
    lines.push(noisy("Pay with your mobile device at"));

    const text = placed ? textFromWords(rows.map((row) => layOut(r, row))) : lines.join("\n");
    const out = parseReceipt(text);
    const got = out.items.map((i) => [i.name, i.qty, i.price]);
    const want = items.map((i) => [i.name, i.qty, i.price]);
    const msg = `seed ${seed}\n${lines.join("\n")}\n---\n${text}`;
    assert.equal(out.merchant, place, msg);
    assert.deepEqual(got.map((g) => g.slice(0, 2)), want.map((w) => w.slice(0, 2)), msg);
    const truth = { items: want, subtotal: sub, tax, total: sub + tax };
    const read = { items: got, subtotal: out.subtotal, tax: out.tax, total: out.total };
    const addsUp = sum(out.items.map((i) => i.price)) === out.subtotal && out.subtotal + out.tax === out.total;
    const misread = faded >= 0 || sums.some((v, k) => v !== [sub, tax, sub + tax][k]);
    if (!misread) {
      assert.deepEqual(read, truth, msg);
    } else if (addsUp) {
      // Whenever the repaired receipt balances, it must be the true one.
      assert.deepEqual(read, truth, msg);
      repaired++;
    } else {
      flagged++;
    }
  }
  assert.ok(repaired > flagged, `repaired ${repaired}, left flagged ${flagged}`);
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

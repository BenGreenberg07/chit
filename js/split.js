// Bill math. Every amount is an integer number of cents so totals always add
// up exactly; fractional shares are rounded once per component with the
// largest-remainder method.

// `first` breaks ties: when two people's fractions are equal, the leftover
// penny goes to that index (the person who paid) before anyone else.
export function allocate(total, weights, first = -1) {
  if (total < 0) return allocate(-total, weights, first).map((c) => -c);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  // Remainders are compared at a fixed precision so float noise never decides
  // who gets a penny between two people who ordered the same thing.
  const order = raw
    .map((r, i) => [Math.round((r - out[i]) * 1e6), i])
    .filter(([, i]) => weights[i] > 0)
    .sort((a, b) => b[0] - a[0] || (b[1] === first) - (a[1] === first) || a[1] - b[1]);
  for (let k = 0; rem > 0; k++, rem--) out[order[k % order.length][1]]++;
  return out;
}

export function tipTotal(tip, subtotal, tax) {
  if (tip.mode === "amount") return Math.max(0, Math.round(tip.amount || 0));
  const base = tip.base === "posttax" ? subtotal + tax : subtotal;
  return Math.max(0, Math.round((base * (tip.percent || 0)) / 100));
}

const EPS = 0.001;

// Someone can say "I had a third" of a shared line. People with a fixed
// portion pay exactly that; everyone else who claimed the line splits what's
// left evenly. Returns each claimer's fraction of the line, always summing to 1.
export function portionShares(claimers, portion = {}) {
  const fixed = claimers.filter((id) => portion[id] > 0);
  const free = claimers.filter((id) => !(portion[id] > 0));
  const sumFixed = fixed.reduce((a, id) => a + portion[id], 0);
  const out = {};
  if (free.length && sumFixed < 1 - EPS) {
    fixed.forEach((id) => (out[id] = portion[id]));
    free.forEach((id) => (out[id] = (1 - sumFixed) / free.length));
  } else {
    // Portions don't fit (over or under 100%): scale them so the line is still
    // fully paid. findIssues flags it so someone fixes it.
    fixed.forEach((id) => (out[id] = portion[id] / sumFixed));
    free.forEach((id) => (out[id] = 0));
  }
  return out;
}

function portionIssue(claimers, portion = {}) {
  const fixed = claimers.filter((id) => portion[id] > 0);
  if (!fixed.length) return null;
  const free = claimers.length - fixed.length;
  const sum = fixed.reduce((a, id) => a + portion[id], 0);
  if (sum > 1 + EPS || (free && sum > 1 - EPS)) return { type: "share-over", sum };
  if (!free && sum < 1 - EPS) return { type: "share-under", sum };
  return { type: "share-ok", sum };
}

// Which items still need a human decision.
export function findIssues(items, people, claims, portions = {}) {
  const ids = new Set(people.map((p) => p.id));
  const issues = [];
  for (const item of items) {
    const c = claims[item.id] || {};
    const claimers = Object.keys(c).filter((id) => ids.has(id) && c[id] > 0);
    const units = claimers.reduce((a, id) => a + c[id], 0);
    const pi = claimers.length ? portionIssue(claimers, portions[item.id]) : null;
    if (pi) {
      if (pi.type !== "share-ok") issues.push({ type: pi.type, item, claimers, units, sum: pi.sum });
      continue;
    }
    if (!claimers.length) issues.push({ type: "unclaimed", item, claimers, units });
    else if (!item.shared && units > item.qty) issues.push({ type: "over", item, claimers, units });
  }
  return issues;
}

export function computeSplit({ items, people, claims, portions = {}, tax = 0, fees = [], tip, covered = [], payer = null }) {
  const n = people.length;
  const subtotal = items.reduce((a, it) => a + it.price, 0);

  // Raw (fractional) food share per person. Unclaimed items fall on everyone
  // so the preview never loses money while claims are still being sorted out.
  const food = new Array(n).fill(0);
  const itemShares = people.map(() => []);
  for (const it of items) {
    const c = claims[it.id] || {};
    let w = people.map((p) => c[p.id] || 0);
    const claimerIds = people.filter((p) => c[p.id] > 0).map((p) => p.id);
    const portion = portions[it.id] || {};
    if (claimerIds.some((id) => portion[id] > 0)) {
      const share = portionShares(claimerIds, portion);
      people.forEach((p, i) => {
        const cents = it.price * (share[p.id] || 0);
        if (!cents) return;
        food[i] += cents;
        itemShares[i].push({ id: it.id, name: it.name, cents, units: c[p.id], portion: portion[p.id] || 0 });
      });
      continue;
    }
    let sum = w.reduce((a, b) => a + b, 0);
    if (!sum) { w = w.map(() => 1); sum = n; }
    // Whoever claimed a line pays for all of it, in proportion to the units
    // they tapped: if Ben is the only one who tapped "2 Dan Dan Noodles", he
    // had both, and nobody else pays for a line they never touched.
    w.forEach((wi, i) => {
      const share = (it.price * wi) / sum;
      if (!share) return;
      food[i] += share;
      itemShares[i].push({ id: it.id, name: it.name, cents: share, units: wi });
    });
  }

  const byFood = subtotal > 0 ? food : people.map(() => 1);
  const feesTotal = fees.reduce((a, f) => a + f.amount, 0);
  const tipCents = tipTotal(tip, subtotal, tax);

  // Each person's exact (fractional) share of every part of the bill.
  const share = (amount, weights) => {
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => (sum > 0 ? (amount * w) / sum : 0));
  };
  const tipWeights = tip.split === "even" ? people.map(() => 1) : byFood;
  const exact = people.map((_, i) =>
    food[i] + share(tax, byFood)[i] + share(feesTotal, byFood)[i] + share(tipCents, tipWeights)[i]);

  // Round each person's total once. Rounding food, tax and tip separately
  // let the same person collect several stray pennies; now people who ordered
  // the same thing differ by at most a cent, and the payer absorbs ties.
  const payerIdx = people.findIndex((p) => p.id === payer);
  const grand = subtotal + tax + feesTotal + tipCents;
  const totals = allocate(grand, exact, payerIdx);

  const foodC = allocate(subtotal, food, payerIdx);
  const taxC = allocate(tax, byFood, payerIdx);
  const feesC = allocate(feesTotal, byFood, payerIdx);
  const rows = people.map((p, i) => {
    // The breakdown is for reading; whatever cent the single rounding moved
    // lands on the tip (or tax) so the parts still add up to the total.
    const r = { id: p.id, food: foodC[i], tax: taxC[i], fees: feesC[i], tip: 0, cover: 0, items: itemShares[i], total: totals[i] };
    const rest = totals[i] - r.food - r.tax - r.fees;
    if (tipCents) r.tip = rest;
    else r.tax += rest;
    return r;
  });

  // Treating someone: their whole share moves onto everyone else in
  // proportion to what each of them already owes.
  const ids = new Set(people.map((p) => p.id));
  const coveredSet = new Set(covered.filter((id) => ids.has(id)));
  if (coveredSet.size && coveredSet.size < n) {
    const moved = rows.filter((r) => coveredSet.has(r.id)).reduce((a, r) => a + r.total, 0);
    const payers = rows.filter((r) => !coveredSet.has(r.id));
    const extra = allocate(moved, payers.map((r) => Math.max(r.total, 1)));
    payers.forEach((r, k) => { r.cover = extra[k]; r.total += extra[k]; });
    rows.filter((r) => coveredSet.has(r.id)).forEach((r) => { r.cover = -r.total; r.total = 0; });
  }

  return {
    rows,
    subtotal,
    tax,
    feesTotal,
    tipTotal: tipCents,
    grandTotal: subtotal + tax + feesTotal + tipCents,
  };
}

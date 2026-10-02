// Bill math. Every amount is an integer number of cents so totals always add
// up exactly; fractional shares are rounded once per component with the
// largest-remainder method.

export function allocate(total, weights) {
  if (total < 0) return allocate(-total, weights).map((c) => -c);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!total || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => [r - out[i], i])
    .filter(([, i]) => weights[i] > 0)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rem > 0; k++, rem--) out[order[k % order.length][1]]++;
  return out;
}

export function tipTotal(tip, subtotal, tax) {
  if (tip.mode === "amount") return Math.max(0, Math.round(tip.amount || 0));
  const base = tip.base === "posttax" ? subtotal + tax : subtotal;
  return Math.max(0, Math.round((base * (tip.percent || 0)) / 100));
}

// Which items still need a human decision.
export function findIssues(items, people, claims) {
  const ids = new Set(people.map((p) => p.id));
  const issues = [];
  for (const item of items) {
    const c = claims[item.id] || {};
    const claimers = Object.keys(c).filter((id) => ids.has(id) && c[id] > 0);
    const units = claimers.reduce((a, id) => a + c[id], 0);
    if (!claimers.length) issues.push({ type: "unclaimed", item, claimers, units });
    else if (!item.shared && units > item.qty) issues.push({ type: "over", item, claimers, units });
    else if (!item.shared && !item.restEven && units < item.qty) issues.push({ type: "under", item, claimers, units });
  }
  return issues;
}

export function computeSplit({ items, people, claims, tax = 0, fees = [], tip, covered = [] }) {
  const n = people.length;
  const subtotal = items.reduce((a, it) => a + it.price, 0);

  // Raw (fractional) food share per person. Unclaimed items fall on everyone
  // so the preview never loses money while claims are still being sorted out.
  const food = new Array(n).fill(0);
  const itemShares = people.map(() => []);
  for (const it of items) {
    const c = claims[it.id] || {};
    let w = people.map((p) => c[p.id] || 0);
    let sum = w.reduce((a, b) => a + b, 0);
    if (!sum) { w = w.map(() => 1); sum = n; }
    // A partly claimed multi-unit item: claimers pay for their units and the
    // remainder spreads over everyone.
    const leftover = !it.shared && sum < it.qty ? it.qty - sum : 0;
    const per = it.price / it.qty;
    w.forEach((wi, i) => {
      const share = leftover ? wi * per + (leftover * per) / n : (it.price * wi) / sum;
      if (!share) return;
      food[i] += share;
      itemShares[i].push({ id: it.id, name: it.name, cents: share, units: wi });
    });
  }

  const byFood = subtotal > 0 ? food : people.map(() => 1);
  const feesTotal = fees.reduce((a, f) => a + f.amount, 0);
  const tipCents = tipTotal(tip, subtotal, tax);

  const foodC = allocate(subtotal, food);
  const taxC = allocate(tax, byFood);
  const feesC = allocate(feesTotal, byFood);
  const tipC = allocate(tipCents, tip.split === "even" ? people.map(() => 1) : byFood);

  const rows = people.map((p, i) => ({
    id: p.id,
    food: foodC[i],
    tax: taxC[i],
    fees: feesC[i],
    tip: tipC[i],
    cover: 0,
    items: itemShares[i],
  }));
  rows.forEach((r) => (r.total = r.food + r.tax + r.fees + r.tip));

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

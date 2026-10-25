// Turns OCR text from a restaurant receipt into line items and totals.
// OCR is noisy, so this aims for "mostly right and easy to fix" rather than
// perfect: anything it gets wrong can be edited on the receipt afterwards.

const PRICE_AT_END = /(-?\$?\s?[0-9OoSIl]{1,4}\s?[.,]\s?[0-9OoSIl]{2})\s*[A-Za-z]{0,2}\s*$/;
const STREET = /^\s*\d{1,6}\s+(?:[NSEW]\.?\s+)?\S.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|pl|place|sq|square|pike|hwy|highway|ct|court|pkwy|parkway)\b\.?/i;

const SUBTOTAL = /\bsub\s*-?\s*tota[l1]|\bfood\s*(?:&|and)?\s*bev|\bsubtt?l\b/i;
const TAX = /\b(sales\s*)?t[aeo@]x\b(?!-)|\b[l1I]ax\b|\bhst\b|\bgst\b|\bvat\b/i;
const TOTAL = /\btota[l1]\b|\b[o0d]ta[l1]\b|\bamount\s*due\b|\bbalance\s*due\b|\bamt\s*due\b/i;
const FEE = /gratuity|\bfees?\b|service\s*charge|auto\s*grat|kitchen\s*appreciation|surcharge|\bsvc\b/i;
// A tip someone already wrote in or added at the register, as opposed to the
// "suggested tip: 18% = ..." lines many receipts print.
const PAID_TIP = /^\s*(added\s*)?(tip|tips|tip\s*amount|gratuity\s*added)\s*:?\s*$/i;
// An automatic gratuity on a large table is the tip, already charged. Reading
// it as a fee would leave Chit asking for a second tip on top of it.
const AUTO_GRAT = /gratuity|auto\s*grat/i;
const SUGGESTED = /suggest|recommend|if\s*you\s*wish/i;
const DISCOUNT = /discount|coupon|promo|\bcomp\b|happy\s*hour\s*adj/i;
const TIP = /\btip\b|suggested|\d{2}\s*%/i;
const SKIP = /visa|master\s*card|amex|discover|\bcash\b|change\s*due|\bcard\b|\bauth|approv|thank|server|\btable\b|guest|\bchk\b|check\s*#|order\s*#|\bdate\b|\btime\b|signature|x{3,}|\*{4}|balance\b(?!\s*due)|tender|payment|receipt|merchant|terminal/i;

const PHONE = /\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]+\d{4}\b/;
const ANY_PRICE = /-?\$?\s?[0-9OoSIl]{1,4}\s?[.,]\s?[0-9OoSIl]{2}(?![0-9a-z])/gi;

// The price is normally the last thing on the line, but photos pick up specks
// and table edges beside the slip, which read as a few stray characters after
// it ("$21.00 bo \\"). Accept a short tail with no second price in it.
function findPrice(line) {
  const m = line.match(PRICE_AT_END);
  if (m) return { token: m[1], index: m.index };
  let last = null;
  for (const x of line.matchAll(ANY_PRICE)) last = x;
  if (!last || !/\d/.test(last[0])) return null;
  const tail = line.slice(last.index + last[0].length);
  if (tail.trim().length > 14) return null;
  return { token: last[0], index: last.index };
}

function toCents(token) {
  const clean = token
    .replace(/[\s$]/g, "")
    .replace(/[Oo]/g, "0")
    .replace(/S/g, "5")
    .replace(/[Il]/g, "1")
    .replace(",", ".");
  const n = Number.parseFloat(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function tidyName(name) {
  return name
    .replace(/\s*@\s*\$?\d+[.,]\d{2}\s*(ea\.?)?\s*$/i, "")
    .replace(/[|_~=]+/g, " ")
    // A speck read as a letter and bracket stuck to the word ("C(Quesabirria").
    .replace(/(^|\s)[A-Za-z]?[([{](?=[A-Za-z]{3})/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.:\-*#]+|[\s.:\-*#]+$/g, "")
    .trim();
}

// Drops margin noise around a line: tokens with no letters or digits, and
// one- or two-character scraps at either end.
// Sizes and units menus print before the dish ("Lg Juice", "Sm Fries").
const SIZE = /^(lg|sm|md|xl|dz|lb|oz|pc|pt|qt|hf)$/i;
// So do the short words in dish names ("Al Pastor", "El Jefe", "Da Vinci").
const ARTICLE = /^(Al|El|La|Le|Lo|De|Da|Di|Du|Il)$/;

function trimNoise(line, { tail = true } = {}) {
  const t = line.split(/\s+/).filter(Boolean);
  const junk = (w) => !/[a-z0-9]/i.test(w) || /[^a-z0-9'&.,$:#/()-]/i.test(w);
  // Short scraps up front: one stray character, or two with lowercase or
  // punctuation ("id", "i]"). Two capitals ("OJ", "BL") may be a real word.
  // So is a short lowercase run with no vowel in it ("ptr)", "fk"), which is
  // wood grain or a crease read as letters — and which, left in place, hides
  // the quantity that follows it.
  const vowelless = (w) => w.length <= 4 && /[a-z]/.test(w) && !/\d/.test(w) && !/[aeiouy]/i.test(w);
  const lead = (w) => !SIZE.test(w) && !ARTICLE.test(w) && (junk(w) || vowelless(w) || (w.length === 1 && !/\d/.test(w)) || (w.length === 2 && !/^(\d+|[A-Z]{2})$/.test(w)));
  while (t.length > 1 && lead(t[0])) t.shift();
  // A lone "|" or "=" partway through means the rest is shading, not text.
  const cut = t.findIndex((w, k) => k > 0 && junk(w));
  if (tail && cut > 0) t.length = cut;
  const end = (w) => junk(w) || w.length <= 2 || /^[a-z]{1,2}[.,]$/.test(w);
  while (tail && t.length > 1 && end(t[t.length - 1])) t.pop();
  return t.join(" ");
}

// Leading "qty name": the quantity is the last number before the first real
// word, so a speck read as "3" in the margin doesn't turn "2 Pomodoro" into 3.
function splitQty(label) {
  const t = label.split(/\s+/).filter(Boolean);
  const first = t.findIndex((w) => /[a-z]{3,}/i.test(w));
  if (first <= 0) return { qty: 1, name: t.join(" ") };
  let j = -1;
  for (let k = 0; k < first; k++) if (/^\d{1,2}[xX]?$/.test(t[k])) j = k;
  if (j >= 0) return { qty: Math.max(1, parseInt(t[j], 10)), name: t.slice(j + 1).join(" ") };
  const rest = t.slice(0, first).filter((w) => (w.length > 1 && /^[A-Za-z]+$/.test(w)) || SIZE.test(w));
  return { qty: 1, name: [...rest, ...t.slice(first)].join(" ") };
}

function capitalize(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}

// The restaurant's name often shares a line with a phone number or date
// ("Pizzata    215-546-7200"), so strip those before deciding.
function merchantFrom(line) {
  const t = line
    .replace(/\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/g, " ")
    .replace(/\b(date|time)\s*:?\s*[\d/:.-]+\s*(am|pm)?/gi, " ")
    .replace(/\d{1,2}[/:]\d{1,2}([/:]\d{2,4})?\s*(am|pm)?/gi, " ")
    .replace(/#\s*\d+/g, " ");
  if (/^\s*(to\s*go|dine\s*in|take\s*out|carry\s*out|pick\s*up|customer|server|guest|order|check|table)\b/i.test(t)) return "";
  if (SKIP.test(t) || /\d{3,}/.test(t) || STREET.test(t)) return "";
  let name = trimNoise(t);
  // "Pizzeria Stella SEE": a shouty scrap after a Title Case name is shading.
  const words = name.split(" ");
  if (words.length > 1 && /^[A-Z]{2,4}$/.test(words.at(-1)) && words.slice(0, -1).every((w) => /^[A-Z][a-z]/.test(w))) {
    name = words.slice(0, -1).join(" ");
  }
  // A name line with a smudged tail ("The Diner at 11 Nc -th Beacon") keeps
  // its clean start ("The Diner").
  if (!looksLikeWords(name)) name = cleanStart(name);
  if (!looksLikeWords(name)) return "";
  return capitalize(tidyName(name));
}

const LINKS = /^(the|at|of|on|and|&|de|la|le|el|da|di|du|n|y)$/i;
function cleanStart(name) {
  const words = name.split(" ");
  let end = 0;
  while (end < words.length && ((/^[a-z'&.-]{3,}$/i.test(words[end]) && /[aeiouy]/i.test(words[end])) || LINKS.test(words[end]))) end++;
  while (end > 0 && LINKS.test(words[end - 1])) end--;
  return words.slice(0, end).join(" ");
}

// Real names are mostly made of real words; logo art reads as scraps like
// "STESLA Se" or "A a | ~ BET ee".
function looksLikeWords(s) {
  const words = s.split(/\s+/);
  const letters = s.replace(/[^a-z]/gi, "").length;
  const inWords = words.filter((w) => /^[a-z'&.]{3,}$/i.test(w) && /[aeiouy]/i.test(w))
    .reduce((n, w) => n + w.replace(/[^a-z]/gi, "").length, 0);
  return letters >= 4 && inWords / letters >= 0.8 && words.some((w) => /^[a-z']{4,}$/i.test(w));
}

const keyOf = (t) => (SUBTOTAL.test(t) ? "subtotal" : TAX.test(t) ? "tax" : TOTAL.test(t) ? "total" : null);

// A wide gap between an item and its price, or a crease across the paper, can
// leave the reader splitting one printed line into two: the name on one line
// and the amount alone on the next (or the one before). Join those back up
// before anything else reads them. Only plain item names qualify — a stray
// "Subtotal" or "Tax" on its own line is realignTotals' job, not this.
// Only a line that reads like a dish gets joined to a loose amount. Junk off
// the table ("Seed ke ne", "Powered by Toast") carries one- and two-letter
// scraps; a menu line is whole words, with at most a quantity in front.
function dishLike(label) {
  const words = label.split(/\s+/).filter(Boolean);
  const letters = words.filter((w) => /[a-z]/i.test(w));
  return letters.length > 0
    && letters.every((w) => /^[a-z'&.-]{3,}$/i.test(w) && /[aeiouy]/i.test(w))
    && words.every((w) => /^[a-z'&.-]+$/i.test(w) || /^\d{1,2}[xX]?$/.test(w))
    && label.replace(/[^a-z]/gi, "").length >= 4;
}

// `from` is where the items can start: the line after the street address, or
// failing that anything but the first line. The restaurant's own name reads as
// dish-like too, and it often sits right above the first amount on the slip.
function joinWrapped(lines, from) {
  const price = lines.map(findPrice);
  const labels = lines.map((l, i) => trimNoise(price[i] ? l.slice(0, price[i].index) : l, { tail: false }));
  const itemName = (i) => i >= from && i < lines.length && !price[i] && dishLike(labels[i])
    && !keyOf(labels[i]) && ![SKIP, TIP, FEE, DISCOUNT, PAID_TIP, AUTO_GRAT].some((re) => re.test(labels[i]));
  const loose = (i) => i >= 0 && i < lines.length && price[i] && !/[a-z]{2,}/i.test(labels[i]);
  if (from >= lines.length) return lines;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (itemName(i) && loose(i + 1)) out.push(`${labels[i]} ${price[i + 1].token}`);
    else if (loose(i) && itemName(i + 1)) out.push(`${labels[i + 1]} ${price[i].token}`);
    else { out.push(lines[i]); continue; }
    i++;
  }
  return out;
}

export function parseReceipt(text) {
  const read = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Trimming the tail would eat the "Dr" or "St" the address is found by.
  const address = read.findIndex((l) => STREET.test(trimNoise(l, { tail: false })));
  const lines = joinWrapped(read, address >= 0 ? address + 1 : 1);
  const out = { merchant: "", items: [], tax: 0, fees: [], subtotal: null, total: null, tip: null };

  // The name printed right above the street address beats anything earlier,
  // which is often a logo the reader turned into letters.
  const street = address;
  for (let k = street - 1; k >= Math.max(0, street - 2) && !out.merchant; k--) {
    out.merchant = merchantFrom(lines[k]);
  }
  // Next best: the name printed beside the phone number ("Pizzata
  // 215-546-7200"); the top of the slip is often a logo read as letters.
  const phone = lines.findIndex((l) => PHONE.test(l));
  if (!out.merchant && phone >= 0) out.merchant = merchantFrom(lines[phone]);

  // Subtotal, tax and total labels and the amounts near them, in reading
  // order, in case the reader paired them wrong (see realignTotals).
  const summary = [];

  for (const [k, line] of lines.entries()) {
    const g = line.match(/\b(?:guests?(?:\s*count)?|covers?|party(?:\s*size)?)\s*[:#]?\s*(\d{1,2})\b/i);
    if (g) out.guests = Number(g[1]);
    const m = findPrice(line);
    if (!m) {
      const key = keyOf(trimNoise(line));
      if (key && trimNoise(line).length <= 20) summary.push({ k, key });
      if (!out.merchant) {
        const name = merchantFrom(line);
        if (name) out.merchant = name;
      }
      continue;
    }
    const cents = toCents(m.token);
    let label = trimNoise(line.slice(0, m.index).trim(), { tail: false });
    // A lone lowercase scrap before an amount is a speck, not an item ("ig $79.00").
    if (/^([a-z]{1,2}|\W*\w\W*)$/.test(label)) label = "";
    const key = /[a-z]{2,}/i.test(label) ? keyOf(label) : null;
    if (key || !/[a-z]{2,}/i.test(label)) {
      if (key) summary.push({ k, key });
      for (const x of line.matchAll(ANY_PRICE)) {
        const c = toCents(x[0]);
        if (c !== null) summary.push({ k, cents: c });
      }
    }
    if (cents === null || !/[a-z]{2,}/i.test(label)) continue;

    if (SUBTOTAL.test(label)) { out.subtotal = cents; continue; }
    // A charged gratuity counts once, as the tip; a second one is a fee.
    if (!SUGGESTED.test(label) && (PAID_TIP.test(label) || AUTO_GRAT.test(label)) && out.tip == null && cents > 0) {
      out.tip = cents;
      continue;
    }
    if (TAX.test(label)) { out.tax += cents; continue; }
    if (FEE.test(label)) { out.fees.push({ name: capitalize(tidyName(label)), amount: cents }); continue; }
    if (DISCOUNT.test(label)) { out.fees.push({ name: capitalize(tidyName(label)), amount: -Math.abs(cents) }); continue; }
    // The first total printed is the bill; later ones are usually card slips.
    if (TOTAL.test(label)) { out.total ??= cents; continue; }
    if (TIP.test(label) || SKIP.test(label)) continue;

    const q = splitQty(label);
    const name = capitalize(tidyName(q.name.replace(/^[xX@]\s+/, "")));
    if (!name || cents === 0) continue;
    out.items.push({ name, qty: q.qty, price: cents });
  }
  realignTotals(out, summary);
  repairDigits(out);
  return out;
}

// Some printers set the amounts half a line above their labels, and a sharp
// photo can then pair "Subtotal" with the tax amount, or leave "Tax" on a
// line of its own. When the receipt doesn't add up as read, re-pair the
// summary labels with the nearby amounts in order and keep a pairing that
// balances.
function realignTotals(r, summary) {
  if (!r.items.length || balances(r)) return;
  const labels = [];
  for (const e of summary) {
    if (!e.key || labels.some((l) => l.key === e.key)) continue;
    labels.push(e);
    if (e.key === "total") break;
  }
  if (labels.length < 2) return;
  const from = labels[0].k - 1;
  const to = labels.at(-1).k + 1;
  const amounts = summary.filter((e) => e.cents != null && e.k >= from && e.k <= to).map((e) => e.cents);
  const trials = [];
  for (let o = 0; o + labels.length <= amounts.length; o++) {
    const trial = { ...r, tax: 0, items: r.items.map((i) => ({ ...i })) };
    labels.forEach((l, i) => { trial[l.key] = amounts[o + i]; });
    trials.push(trial);
  }
  // A pairing that balances as is, or after fixing one faded digit.
  let pick = trials.find(balances);
  if (!pick) {
    pick = trials.find((t) => { repairDigits(t); return balances(t); });
    if (pick) r.items = pick.items;
  }
  // Nothing balances, but there's exactly one amount per label: pair them in
  // order so the receipt check can show what's off.
  pick ??= labels.length === amounts.length ? trials[0] : null;
  if (pick) {
    for (const l of labels) r[l.key] = pick[l.key];
    if (balances(r)) return;
  }
  // An amount on its own between Subtotal and Total, with no tax label read
  // (a crease or another slip over it), is the tax if that makes it balance.
  const sub = labels.find((l) => l.key === "subtotal");
  const tot = labels.find((l) => l.key === "total");
  if (!r.tax && sub && tot && !labels.some((l) => l.key === "tax")) {
    const between = summary.filter((e) => e.cents != null && e.k > sub.k && e.k < tot.k).map((e) => e.cents);
    for (const tax of between) {
      const trial = { ...r, tax, items: r.items.map((i) => ({ ...i })) };
      repairDigits(trial);
      if (balances(trial) && tax <= trial.subtotal * 0.2) {
        Object.assign(r, trial);
        return;
      }
    }
  }
  // "Tax" printed but its amount never read: whatever the subtotal and total
  // leave over is the tax, if that's a believable rate.
  const items = r.items.reduce((s, i) => s + i.price, 0);
  const fees = r.fees.reduce((s, f) => s + f.amount, 0);
  if (!r.tax && labels.some((l) => l.key === "tax") && r.subtotal === items && r.total != null) {
    const tax = r.total - items - fees - (r.tip ?? 0);
    if (tax > 0 && tax <= items * 0.2) r.tax = tax;
  }
}

// Thermal print fades, and the reader then mixes up digits with similar
// shapes (3 and 8, 6 and 8, 1 and 7). The receipt checks itself: the lines
// add up to the subtotal, and subtotal, fees, tax and tip add up to the
// total. When those disagree and exactly one single-digit swap anywhere
// (any line, the subtotal, the tax or the total) makes everything agree,
// that swap is the misread. If no swap or several fit, nothing changes and
// the receipt check shows the mismatch instead.
const LOOKALIKE = {
  0: "689", 1: "47", 2: "7", 3: "589", 4: "19", 5: "368", 6: "058", 7: "12", 8: "03569", 9: "0348",
};
function repairDigits(r) {
  if (!r.items.length) return;
  const fees = r.fees.reduce((s, f) => s + f.amount, 0);
  const discounts = r.fees.reduce((s, f) => s + Math.min(0, f.amount), 0);
  const tip = r.tip ?? 0;
  // Receipts differ on whether discounts and fees sit above the subtotal.
  const subOk = (items, subtotal) => subtotal == null || [items, items + discounts, items + fees].includes(subtotal);
  // A cent or two off on the total is the printer's rounding, not a misread.
  const totalOk = (items, tax, total) => total == null || Math.abs(items + fees + tax + tip - total) <= 2;
  const sum = r.items.reduce((s, i) => s + i.price, 0);
  const ok = (items, subtotal, tax, total) => subOk(items, subtotal) && totalOk(items, tax, total);
  if (ok(sum, r.subtotal, r.tax, r.total)) return;

  const fixes = [];
  for (const item of r.items) {
    for (const price of lookalikes(item.price)) {
      if (ok(sum - item.price + price, r.subtotal, r.tax, r.total)) fixes.push(() => { item.price = price; });
    }
  }
  if (r.subtotal != null) {
    for (const v of lookalikes(r.subtotal)) if (ok(sum, v, r.tax, r.total)) fixes.push(() => { r.subtotal = v; });
  }
  if (r.tax) {
    for (const v of lookalikes(r.tax)) if (ok(sum, r.subtotal, v, r.total)) fixes.push(() => { r.tax = v; });
  }
  if (r.total != null) {
    for (const v of lookalikes(r.total)) if (ok(sum, r.subtotal, r.tax, v)) fixes.push(() => { r.total = v; });
  }
  if (fixes.length === 1) return fixes[0]();

  // The lines, tax and total all agree and only the printed subtotal is off
  // by a dropped or changed digit ("$79.00" read as "09.00"): trust the rest.
  if (r.subtotal != null && r.total != null && sum + fees + r.tax + tip === r.total) {
    const ways = [...new Set([sum, sum + discounts, sum + fees])];
    if (ways.length === 1 && oneDigitApart(String(r.subtotal), String(ways[0]))) r.subtotal = ways[0];
  }
}

// One digit dropped, added or changed: "900" vs "7900", "7100" vs "7900".
function oneDigitApart(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
}

function lookalikes(cents) {
  const digits = String(cents);
  const out = [];
  for (let d = 0; d < digits.length; d++) {
    for (const alt of LOOKALIKE[digits[d]] ?? "") out.push(Number(digits.slice(0, d) + alt + digits.slice(d + 1)));
  }
  return out;
}

// How much to trust a read: one whose lines, subtotal, tax and total all
// agree beats anything else; otherwise more of the receipt found is better.
function checks(r) {
  const fees = r.fees.reduce((s, f) => s + f.amount, 0);
  const discounts = r.fees.reduce((s, f) => s + Math.min(0, f.amount), 0);
  const items = r.items.reduce((s, i) => s + i.price, 0);
  return {
    subOk: r.subtotal != null && [items, items + discounts, items + fees].includes(r.subtotal),
    totalOk: r.total != null && Math.abs(items + fees + r.tax + (r.tip ?? 0) - r.total) <= 2,
  };
}

function balances(r) {
  const { subOk, totalOk } = checks(r);
  return subOk && totalOk;
}

export function readScore(r) {
  const { subOk, totalOk } = checks(r);
  return (subOk && totalOk ? 1000 : subOk || totalOk ? 500 : 0)
    + r.items.length * 10 + (r.subtotal != null) + (r.total != null) + (r.tax > 0) + (r.merchant ? 1 : 0);
}

export function addsUp(r) {
  return readScore(r) >= 1000;
}

// Rebuilds the reader's text from word positions, dropping specks that sit
// far out in the margin. Real words on a receipt line are a space apart; a
// speck on the table or the slip's edge is many spaces away from the text.
// Only the start of a line and anything after its last price are trimmed,
// since the price itself always sits far right of the item name.
// `lines` is [{ words: [{ text, bbox: { x0, x1 } }] }] as the reader returns.
export function textFromWords(lines) {
  const gaps = [];
  for (const l of lines) {
    for (let k = 1; k < l.words.length; k++) gaps.push(l.words[k].bbox.x0 - l.words[k - 1].bbox.x1);
  }
  if (!gaps.length) return lines.map((l) => l.words.map((w) => w.text).join(" ")).join("\n");
  gaps.sort((a, b) => a - b);
  const far = Math.max(12, gaps[Math.floor(gaps.length * 0.25)] * 4);
  const gap = (ws, k) => ws[k].bbox.x0 - ws[k - 1].bbox.x1;
  return lines.map((l) => {
    let ws = l.words.filter((w) => w.text.trim());
    const speck = (t) => t.length <= 3 && !/[a-z]{3}/i.test(t) && !/\d[.,]\d\d/.test(t);
    while (ws.length > 1 && gap(ws, 1) > far && speck(ws[0].text)) ws = ws.slice(1);
    const last = ws.findLastIndex((w) => /\d[.,]\d\d/.test(w.text));
    if (last >= 0) {
      let end = last + 1;
      while (end < ws.length && gap(ws, end) <= far) end++;
      ws = ws.slice(0, end);
    } else {
      while (ws.length > 1 && gap(ws, ws.length - 1) > far && speck(ws.at(-1).text)) ws = ws.slice(0, -1);
    }
    return ws.map((w) => w.text).join(" ");
  }).join("\n");
}

// Rebuilds receipt lines from loose words (the reader's sparse mode), pairing
// each price with its label ourselves. Some printers set the price column
// half a line above the labels, and a curled or tilted slip makes that offset
// drift down the page, so "nearest line" pairing goes wrong by the totals.
// Prices and labels both run top to bottom, so the pairing is an ordered
// alignment: each price goes to a later row than the price before it, and the
// offset between price and label may only change gradually. Rows left over
// (modifiers like "ADD Bacon") stay as text; a price no row fits stays a bare
// amount.
// `words` is [{ text, confidence, bbox: { x0, y0, x1, y1 } }].
export function linesFromWords(words) {
  const isPrice = (t) => /^-?\$?\d{1,4}[.,]\d{2}$/.test(t.replace(/[§S](?=\d)/, "$").replace(/[^\d$.,-]/g, ""))
    && /\d[.,]\d\d/.test(t);
  const usable = words.filter((w) => w.text.trim() && (w.confidence ?? 100) >= 30);
  if (!usable.length) return "";
  const heights = usable.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const h = heights[heights.length >> 1] || 20;
  const yc = (w) => (w.bbox.y0 + w.bbox.y1) / 2;

  // Rows of label words, by height on the page.
  const rows = [];
  for (const w of usable.filter((w) => !isPrice(w.text)).sort((a, b) => yc(a) - yc(b))) {
    const row = rows.at(-1);
    if (row && Math.abs(yc(w) - row.y) < h * 0.55) {
      row.words.push(w);
      row.y = row.words.reduce((s, x) => s + yc(x), 0) / row.words.length;
    } else {
      rows.push({ y: yc(w), words: [w] });
    }
  }
  // Prices on the same height belong together ("2 @ 7.00   14.00").
  const prices = [];
  for (const w of usable.filter((w) => isPrice(w.text)).sort((a, b) => yc(a) - yc(b))) {
    const last = prices.at(-1);
    if (last && Math.abs(yc(w) - last.y) < h * 0.4) last.words.push(w);
    else prices.push({ y: yc(w), words: [w] });
  }

  // Ordered alignment by dynamic programming: cost[i][j] is the best way to
  // place prices 0..i with price i on row j. Steps are charged by how much the
  // offset changes; the first by its size. A price may also stay unplaced.
  const n = prices.length;
  const m = rows.length;
  const SKIP = (h * 1.6) ** 2;
  const dy = (i, j) => prices[i].y - rows[j].y;
  const reach = h * 1.4;
  const cost = Array.from({ length: n }, () => new Float64Array(m + 1).fill(Infinity));
  const from = Array.from({ length: n }, () => new Int32Array(m + 1).fill(-2));
  // Column m means "unplaced"; it carries the last placed row and offset.
  const lastRow = Array.from({ length: n }, () => new Int32Array(m + 1).fill(-1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= m; j++) {
      const placing = j < m;
      if (placing && Math.abs(dy(i, j)) > reach) continue;
      if (i === 0) {
        cost[0][j] = placing ? (dy(0, j) / 2) ** 2 : SKIP;
        lastRow[0][j] = placing ? j : -1;
        from[0][j] = -1;
        continue;
      }
      for (let k = 0; k <= m; k++) {
        const prev = cost[i - 1][k];
        if (prev === Infinity) continue;
        const pr = lastRow[i - 1][k];
        let step;
        if (!placing) step = SKIP;
        else if (pr >= 0 && j <= pr) continue;
        else if (pr < 0) step = (dy(i, j) / 2) ** 2;
        else {
          // Offset of the previous placed price against its row.
          let pi = i - 1;
          let pk = k;
          while (pk === m && pi > 0) { pk = from[pi][pk]; pi--; }
          step = (dy(i, j) - (prices[pi].y - rows[pr].y)) ** 2;
        }
        if (prev + step < cost[i][j]) {
          cost[i][j] = prev + step;
          from[i][j] = k;
          lastRow[i][j] = placing ? j : pr;
        }
      }
    }
  }
  const owner = new Map();
  if (n) {
    let j = 0;
    for (let k = 1; k <= m; k++) if (cost[n - 1][k] < cost[n - 1][j]) j = k;
    for (let i = n - 1; i >= 0; i--) {
      if (j < m) owner.set(j, prices[i]);
      j = from[i][j];
    }
  }

  const text = (ws) => ws.sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => w.text).join(" ");
  const lines = rows.map((row, j) => ({ y: row.y, text: text(owner.has(j) ? [...row.words, ...owner.get(j).words] : row.words) }));
  const placed = new Set(owner.values());
  for (const p of prices) if (!placed.has(p)) lines.push({ y: p.y, text: text(p.words) });
  return lines.sort((a, b) => a.y - b.y).map((l) => l.text).join("\n");
}

// Fills in a read from other reads of the same photo. Each way of reading has
// blind spots: reading word by word recovers prices printed off their lines
// but drops lone digits like a quantity column, while reading by lines keeps
// the quantities and loses an offset price. Lines are matched by price, in
// order; a matched line takes the other read's quantity when this one saw
// none, and its name when that name reads more like words.
export function hasScraps(r) {
  return r.items.some((i) => scraps(i.name));
}

export function mergeReads(best, others) {
  const out = { ...best, items: best.items.map((i) => ({ ...i })) };
  for (const other of others) {
    const a = out.items;
    const b = other.items;
    // Longest common run of prices, by dynamic programming.
    const L = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        L[i][j] = a[i].price === b[j].price ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      }
    }
    const pairs = [];
    for (let i = 0, j = 0; i < a.length && j < b.length;) {
      if (a[i].price === b[j].price) pairs.push([i++, j++]);
      else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
    // Between two matched lines, the same number of unmatched lines on each
    // side with the same names are the same lines, one price misread.
    const fences = [[-1, -1], ...pairs, [a.length, b.length]];
    for (let f = 1; f < fences.length; f++) {
      const [i0, j0] = fences[f - 1];
      const [i1, j1] = fences[f];
      if (i1 - i0 !== j1 - j0) continue;
      for (let k = 1; i0 + k < i1; k++) {
        if (sameName(a[i0 + k].name, b[j0 + k].name)) pairs.push([i0 + k, j0 + k]);
      }
    }
    for (const [i, j] of pairs) {
      if (a[i].qty === 1 && b[j].qty > 1) a[i].qty = b[j].qty;
      // Take the other name when this one is broken up, or cut short
      // ("Asada Tac" where the other read has "Asada Taco").
      const longer = b[j].name.length > a[i].name.length && b[j].name.length - a[i].name.length <= 3
        && b[j].name.toLowerCase().startsWith(a[i].name.toLowerCase());
      if ((scraps(a[i].name) && !scraps(b[j].name)) || longer) a[i].name = b[j].name;
    }
  }
  return out;
}

// Names close enough to be the same line read twice (letter pairs in common).
function sameName(x, y) {
  const pairs = (s) => {
    const t = s.toLowerCase().replace(/[^a-z]/g, "");
    const out = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
  };
  const p = pairs(x);
  const q = pairs(y);
  if (!p.length || !q.length) return false;
  let common = 0;
  const pool = [...q];
  for (const g of p) {
    const at = pool.indexOf(g);
    if (at >= 0) { common++; pool.splice(at, 1); }
  }
  return (2 * common) / (p.length + q.length) >= 0.6;
}

// Lowercase pieces of a split word ("ue abi rria" for Quesabirria) or
// letters with no vowel: the name was misread, and another read may do better.
function scraps(name) {
  return name.split(/\s+/).some((w) => {
    const letters = w.replace(/[^a-z]/gi, "");
    if (!letters || w === "w/" || LINKS.test(w) || SIZE.test(w) || ARTICLE.test(w)) return false;
    if (letters.length >= 3 && !/[aeiouy]/i.test(letters)) return !/^[A-Z]+$/.test(letters);
    return /^[a-z]{1,3}$/.test(w) || (/^[a-z]/.test(w) && /[A-Z]/.test(name));
  });
}

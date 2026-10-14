// Turns OCR text from a restaurant receipt into line items and totals.
// OCR is noisy, so this aims for "mostly right and easy to fix" rather than
// perfect: anything it gets wrong can be edited on the receipt afterwards.

const PRICE_AT_END = /(-?\$?\s?[0-9OoSIl]{1,4}\s?[.,]\s?[0-9OoSIl]{2})\s*[A-Za-z]{0,2}\s*$/;
const STREET = /^\s*\d{1,6}\s+(?:[NSEW]\.?\s+)?\S.*\b(st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|way|pl|place|sq|square|pike|hwy|highway|ct|court|pkwy|parkway)\b\.?/i;

const SUBTOTAL = /\bsub\s*-?\s*tota[l1]|\bfood\s*(?:&|and)?\s*bev|\bsubtt?l\b/i;
const TAX = /\b(sales\s*)?tax\b|\bhst\b|\bgst\b|\bvat\b/i;
const TOTAL = /\btota[l1]\b|\bamount\s*due\b|\bbalance\s*due\b|\bamt\s*due\b/i;
const FEE = /gratuity|\bfees?\b|service\s*charge|auto\s*grat|kitchen\s*appreciation|surcharge|\bsvc\b/i;
// A tip someone already wrote in or added at the register, as opposed to the
// "suggested tip: 18% = ..." lines many receipts print.
const PAID_TIP = /^\s*(added\s*)?(tip|tips|tip\s*amount|gratuity\s*added)\s*:?\s*$/i;
const DISCOUNT = /discount|coupon|promo|\bcomp\b|happy\s*hour\s*adj/i;
const TIP = /\btip\b|suggested|\d{2}\s*%/i;
const SKIP = /visa|master\s*card|amex|discover|\bcash\b|change\s*due|\bcard\b|\bauth|approv|thank|server|\btable\b|guest|\bchk\b|check\s*#|order\s*#|\bdate\b|\btime\b|signature|x{3,}|\*{4}|balance\b(?!\s*due)|tender|payment|receipt|merchant|terminal/i;

const ANY_PRICE = /-?\$?\s?[0-9OoSIl]{1,4}\s?[.,]\s?[0-9OoSIl]{2}(?![0-9])/g;

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
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.:\-*#]+|[\s.:\-*#]+$/g, "")
    .trim();
}

// Drops margin noise around a line: tokens with no letters or digits, and
// one- or two-character scraps at either end.
function trimNoise(line, { tail = true } = {}) {
  const t = line.split(/\s+/).filter(Boolean);
  const junk = (w) => !/[a-z0-9]/i.test(w) || /[^a-z0-9'&.,$:#/()-]/i.test(w);
  // Short scraps up front: one stray character, or two with lowercase or
  // punctuation ("id", "i]"). Two capitals ("OJ", "BL") may be a real word.
  const lead = (w) => junk(w) || (w.length === 1 && !/\d/.test(w)) || (w.length === 2 && !/^(\d+|[A-Z]{2})$/.test(w));
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
  const rest = t.slice(0, first).filter((w) => w.length > 1 && /^[A-Za-z]+$/.test(w));
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
  if (SKIP.test(t) || /\d{3,}/.test(t)) return "";
  let name = trimNoise(t);
  // "Pizzeria Stella SEE": a shouty scrap after a Title Case name is shading.
  const words = name.split(" ");
  if (words.length > 1 && /^[A-Z]{2,4}$/.test(words.at(-1)) && words.slice(0, -1).every((w) => /^[A-Z][a-z]/.test(w))) {
    name = words.slice(0, -1).join(" ");
  }
  if (!looksLikeWords(name)) return "";
  return capitalize(tidyName(name));
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

export function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = { merchant: "", items: [], tax: 0, fees: [], subtotal: null, total: null, tip: null };

  // The name printed right above the street address beats anything earlier,
  // which is often a logo the reader turned into letters.
  const street = lines.findIndex((l) => STREET.test(trimNoise(l)));
  for (let k = street - 1; k >= Math.max(0, street - 2) && !out.merchant; k--) {
    out.merchant = merchantFrom(lines[k]);
  }

  for (const line of lines) {
    const g = line.match(/\b(?:guests?(?:\s*count)?|covers?|party(?:\s*size)?)\s*[:#]?\s*(\d{1,2})\b/i);
    if (g) out.guests = Number(g[1]);
    const m = findPrice(line);
    if (!m) {
      if (!out.merchant) {
        const name = merchantFrom(line);
        if (name) out.merchant = name;
      }
      continue;
    }
    const cents = toCents(m.token);
    const label = trimNoise(line.slice(0, m.index).trim(), { tail: false });
    if (cents === null || !/[a-z]{2,}/i.test(label)) continue;

    if (SUBTOTAL.test(label)) { out.subtotal = cents; continue; }
    if (PAID_TIP.test(label)) { out.tip = cents; continue; }
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
  repairDigits(out);
  return out;
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

  // The lines, tax and total all agree and only the printed subtotal is off,
  // even by more than one digit ("$79.00" read as "09.00"): trust the rest.
  if (r.subtotal != null && r.total != null && sum + fees + r.tax + tip === r.total) {
    const ways = [...new Set([sum, sum + discounts, sum + fees])];
    if (ways.length === 1) r.subtotal = ways[0];
  }
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
export function readScore(r) {
  const fees = r.fees.reduce((s, f) => s + f.amount, 0);
  const items = r.items.reduce((s, i) => s + i.price, 0);
  const subOk = r.subtotal != null && [items, items + fees, items + Math.min(0, fees)].includes(r.subtotal);
  const totalOk = r.total != null && Math.abs(items + fees + r.tax + (r.tip ?? 0) - r.total) <= 2;
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

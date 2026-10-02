// Turns OCR text from a restaurant receipt into line items and totals.
// OCR is noisy, so this aims for "mostly right and easy to fix" rather than
// perfect: anything it gets wrong can be edited on the receipt afterwards.

const PRICE_AT_END = /(-?\$?\s?[0-9OoSIl]{1,4}\s?[.,]\s?[0-9OoSIl]{2})\s*[A-Za-z]{0,2}\s*$/;

const SUBTOTAL = /\bsub\s*-?\s*tota[l1]|\bfood\s*(?:&|and)?\s*bev|\bsubtt?l\b/i;
const TAX = /\b(sales\s*)?tax\b|\bhst\b|\bgst\b|\bvat\b/i;
const TOTAL = /\btota[l1]\b|\bamount\s*due\b|\bbalance\s*due\b|\bamt\s*due\b/i;
const FEE = /gratuity|service\s*(charge|fee)|auto\s*grat|kitchen\s*appreciation|surcharge|delivery\s*fee|\bsvc\b/i;
const DISCOUNT = /discount|coupon|promo|\bcomp\b|happy\s*hour\s*adj/i;
const TIP = /\btip\b|suggested|\d{2}\s*%/i;
const SKIP = /visa|master\s*card|amex|discover|\bcash\b|change\s*due|\bcard\b|\bauth|approv|thank|server|\btable\b|guest|\bchk\b|check\s*#|order\s*#|\bdate\b|\btime\b|signature|x{3,}|\*{4}|balance\b(?!\s*due)|tender|payment|receipt|merchant|terminal/i;

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

function capitalize(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}

export function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = { merchant: "", items: [], tax: 0, fees: [], subtotal: null, total: null };

  for (const line of lines) {
    const g = line.match(/\b(?:guests?|covers?|party)\s*[:#]?\s*(\d{1,2})\b/i);
    if (g) out.guests = Number(g[1]);
    const m = line.match(PRICE_AT_END);
    if (!m) {
      if (!out.merchant && /[a-z]{3,}/i.test(line) && !SKIP.test(line) && !/\d{3,}/.test(line)) {
        out.merchant = capitalize(tidyName(line));
      }
      continue;
    }
    const cents = toCents(m[1]);
    const label = line.slice(0, m.index).trim();
    if (cents === null || !/[a-z]{2,}/i.test(label)) continue;

    if (SUBTOTAL.test(label)) { out.subtotal = cents; continue; }
    if (TAX.test(label)) { out.tax += cents; continue; }
    if (FEE.test(label)) { out.fees.push({ name: capitalize(tidyName(label)), amount: cents }); continue; }
    if (DISCOUNT.test(label)) { out.fees.push({ name: capitalize(tidyName(label)), amount: -Math.abs(cents) }); continue; }
    // The first total printed is the bill; later ones are usually card slips.
    if (TOTAL.test(label)) { out.total ??= cents; continue; }
    if (TIP.test(label) || SKIP.test(label)) continue;

    let qty = 1;
    let name = label;
    const q = name.match(/^(\d{1,2})\s*(?:x\b|X\b|@)?\s*(?=[A-Za-z])/);
    if (q) { qty = Math.max(1, Number(q[1])); name = name.slice(q[0].length); }
    name = capitalize(tidyName(name));
    if (!name || cents === 0) continue;
    out.items.push({ name, qty, price: cents });
  }
  return out;
}

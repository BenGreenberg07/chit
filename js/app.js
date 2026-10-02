import { parseReceipt } from "./parse.js";
import { computeSplit, findIssues, portionShares } from "./split.js";
import { Room, newCode, cleanCode } from "./sync.js";

// Pen colors people write with. Red is kept out: it belongs to conflicts.
const INKS = ["#2447B5", "#1C7A4A", "#B1286B", "#C45F12", "#0E7686", "#7A4A26", "#3C4248", "#6B7418"];
const STEPS = [
  { id: "receipt", label: "Receipt" },
  { id: "table", label: "Table" },
  { id: "claim", label: "Claim" },
  { id: "tip", label: "Tip" },
  { id: "settle", label: "Settle" },
];
const STORE = "chit.bill.v1";
const SAMPLE = {
  merchant: "Fourth Street Noodle Co.",
  items: [
    { name: "Dan Dan Noodles", qty: 2, price: 2800 },
    { name: "Pork Buns", qty: 3, price: 1350 },
    { name: "Smashed Cucumber", qty: 1, price: 800 },
    { name: "Spicy Wontons", qty: 1, price: 1100 },
    { name: "Scallion Pancake", qty: 1, price: 950 },
    { name: "Tsingtao", qty: 4, price: 2400 },
    { name: "Mango Shaved Ice", qty: 1, price: 1000 },
  ],
  tax: 832, fees: [], subtotal: 10400, total: 11232, guests: 4,
};

const blank = () => ({
  step: "receipt",
  manual: false,
  merchant: "",
  items: [],
  tax: 0,
  fees: [],
  printed: { subtotal: null, total: null },
  guests: null,
  people: [],
  payer: null,
  claims: {},
  portions: {},
  claimMode: "together",
  claimChecked: false,
  active: null,
  priv: { started: false, index: 0, handoff: true, done: false, revealed: false },
  tip: { mode: "percent", percent: 20, amount: 0, base: "pretax", split: "proportional", picker: null },
  covered: [],
  paid: [],
});

let S = load();

// ---------- live bills ----------
// `live` is this phone's membership: { code, me, host }. The bill itself lives
// in S like any other bill, mirrored to the room as keyed facts.
const LIVE_KEY = "chit.live";
let live = (() => { try { return JSON.parse(localStorage.getItem(LIVE_KEY)); } catch { return null; } })();
const clientId = (() => {
  try {
    let id = localStorage.getItem("chit.client");
    if (!id) localStorage.setItem("chit.client", (id = Math.random().toString(36).slice(2, 12)));
    return id;
  } catch { return Math.random().toString(36).slice(2, 12); }
})();
let room = null;
let lastShared = {};
let lastHostStep = null;
let joining = null;
let liveSheet = false;
let ocr = null;
let photo = null;
let printing = false;
let revealing = false;
let lastStep = null;
const shown = new Map();
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const seenMarks = new Set();
const seenCircles = new Set();
const flashLines = new Set();
const touch = matchMedia("(pointer: coarse)");

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (c) => (c < 0 ? "-" : "") + (Math.abs(c) / 100).toFixed(2);
const dollars = (c) => (c < 0 ? "−$" : "$") + (Math.abs(c) / 100).toFixed(2);
const person = (id) => S.people.find((p) => p.id === id);
const inkOf = (id) => person(id)?.ink ?? "var(--ui)";
const parseMoney = (v) => {
  const n = Number.parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return { ...blank(), ...JSON.parse(raw) };
  } catch {}
  return blank();
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch {}
}

function initials(p) {
  const name = p.name.trim();
  const first = (name[0] || "?").toUpperCase();
  const clash = S.people.some((q) => q.id !== p.id && q.name.trim()[0]?.toUpperCase() === first);
  return clash ? first + (name[1] || "").toLowerCase() : first;
}

function nextInk() {
  const used = new Set(S.people.map((p) => p.ink));
  return INKS.find((c) => !used.has(c)) ?? INKS[S.people.length % INKS.length];
}

const split = () => computeSplit({ items: S.items, people: S.people, claims: S.claims, portions: S.portions, tax: S.tax, fees: S.fees, tip: S.tip, covered: S.covered });
const issues = () => findIssues(S.items, S.people, S.claims, S.portions);

// Portions people can pick for a shared line, and how they read.
const FRACTIONS = [[1 / 4, "¼"], [1 / 3, "⅓"], [1 / 2, "½"], [2 / 3, "⅔"], [3 / 4, "¾"]];
const fracLabel = (f) => (FRACTIONS.find(([v]) => Math.abs(v - f) < 0.01) || [0, `${Math.round(f * 100)}%`])[1];
let openPortion = null;

function canVisit(id) {
  if (id === "receipt") return true;
  if (!S.items.length) return false;
  if (id === "table") return true;
  return S.people.length >= 2;
}

function privateClaimer() {
  const p = S.priv;
  if (S.claimMode !== "private" || !p.started || p.done) return null;
  return S.people[p.index]?.id ?? null;
}

// Whose pen is currently touching the receipt.
function activeClaimer() {
  if (S.step !== "claim") return null;
  if (S.claimMode === "private") return S.priv.handoff ? null : privateClaimer();
  if (!person(S.active)) S.active = (live && person(live.me) ? live.me : S.people[0]?.id) ?? null;
  return S.active;
}

const marksHidden = () => S.step === "claim" && S.claimMode === "private" && !S.priv.revealed;
// While people are still tapping, only real conflicts get circled; unclaimed
// lines wait until someone says they're done.
function visibleIssues() {
  if (S.step !== "claim") return [];
  if (S.claimMode === "private") return S.priv.revealed ? issues() : [];
  return S.claimChecked ? issues() : issues().filter((i) => i.type !== "unclaimed" && i.type !== "under");
}

// ---------- receipt ----------
function renderReceipt() {
  const el = $("#receipt");
  $("#bar-merchant").textContent = S.merchant;

  if (ocr?.status === "reading") {
    el.innerHTML = `
      <div class="scan">
        <img src="${photo}" alt="Your receipt photo">
        <div class="scan-beam"></div>
      </div>`;
    return;
  }
  if (!S.items.length && !S.manual) {
    el.innerHTML = `
      <div class="paper paper-stub">
        <p class="stub-text">Waiting for a receipt</p>
        <div class="stub-rows" aria-hidden="true"><i></i><i></i><i></i></div>
      </div>`;
    return;
  }

  const editing = S.step === "receipt";
  const sp = split();
  const flagged = new Map(visibleIssues().map((i) => [i.item.id, i]));
  const act = activeClaimer();
  const tipShown = S.step === "tip" || S.step === "settle";
  const picker = person(S.tip.picker) ?? person(S.payer) ?? S.people[0];
  const pctLabel = S.tip.mode === "percent" ? ` ${S.tip.percent}%` : "";

  const feeRows = S.fees.map((f) => editing
    ? `<div class="t-row"><dt><input class="t-edit" data-key="fn-${f.id}" data-field="fee-name" data-id="${f.id}" value="${esc(f.name)}" aria-label="Fee name"></dt>
        <dd><input class="t-edit num" data-key="fa-${f.id}" data-field="fee-amount" data-id="${f.id}" value="${money(f.amount)}" inputmode="decimal" aria-label="${esc(f.name)} amount">
        <button class="l-del" data-action="del-fee" data-id="${f.id}" aria-label="Remove ${esc(f.name)}">×</button></dd></div>`
    : `<div class="t-row"><dt>${esc(f.name)}</dt><dd>${money(f.amount)}</dd></div>`).join("");

  el.innerHTML = `
    <article class="paper${printing ? " printing" : ""}">
      <header class="p-head">
        ${editing
          ? `<input class="p-merchant" data-key="merchant" data-field="merchant" value="${esc(S.merchant)}" placeholder="Restaurant name" aria-label="Restaurant name">`
          : `<h1 class="p-merchant">${esc(S.merchant || "Receipt")}</h1>`}
        <p class="p-meta">${S.items.length} line${S.items.length === 1 ? "" : "s"}${S.guests ? ` · ${S.guests} guests` : ""}</p>
      </header>
      <hr class="p-rule">
      <ol class="p-lines">${S.items.map((it) => lineHTML(it, { editing, act, flag: flagged.get(it.id) })).join("")}</ol>
      ${editing ? `<button class="p-add" data-action="add-line">+ Add a line</button>` : ""}
      <hr class="p-rule">
      <dl class="p-totals">
        <div class="t-row"><dt>Subtotal</dt><dd>${money(sp.subtotal)}</dd></div>
        <div class="t-row"><dt>Tax</dt><dd>${editing
          ? `<input class="t-edit num" data-key="tax" data-field="tax" value="${money(S.tax)}" inputmode="decimal" aria-label="Tax">`
          : money(S.tax)}</dd></div>
        ${feeRows}
        ${editing ? `<button class="p-add p-add-sm" data-action="add-fee">+ Fee or discount</button>` : ""}
        <div class="t-row t-strong"><dt>Total</dt><dd>${money(sp.subtotal + sp.tax + sp.feesTotal)}</dd></div>
      </dl>
      <dl class="p-sign">
        <div class="t-row"><dt>Tip${tipShown ? pctLabel : ""}</dt><dd class="blank">${tipShown ? ink("tip", money(sp.tipTotal), picker?.ink) : ""}</dd></div>
        <div class="t-row"><dt>Total</dt><dd class="blank">${tipShown ? ink("grand", money(sp.grandTotal), picker?.ink) : ""}</dd></div>
      </dl>
      <p class="p-foot">${S.step === "settle" && picker ? ink("sig", picker.name, picker.ink, "sig") : "Thank you"}</p>
    </article>`;
  printing = false;
}

// Handwriting. Animates only when the written value changes.
function ink(key, text, color = "var(--blue)", extra = "") {
  const fresh = shown.get(key) !== text;
  shown.set(key, text);
  return `<span class="ink ${extra}${fresh ? " write" : ""}" style="--ink:${color}">${esc(text)}</span>`;
}

function lineHTML(it, { editing, act, flag }) {
  if (editing) {
    return `<li class="line line-edit">
      <input class="l-qty" data-key="q-${it.id}" data-field="qty" data-id="${it.id}" value="${it.qty}" inputmode="numeric" aria-label="Quantity">
      <input class="l-name" data-key="n-${it.id}" data-field="name" data-id="${it.id}" value="${esc(it.name)}" placeholder="Item" aria-label="Item name">
      <input class="l-price" data-key="p-${it.id}" data-field="price" data-id="${it.id}" value="${money(it.price)}" inputmode="decimal" aria-label="${esc(it.name) || "Item"} price">
      <button class="l-del" data-action="del-line" data-id="${it.id}" aria-label="Remove ${esc(it.name) || "line"}">×</button>
    </li>`;
  }
  const c = S.claims[it.id] || {};
  const claimers = S.people.filter((p) => c[p.id] > 0 && (!marksHidden() || p.id === privateClaimer()));
  const marks = claimers.map((p) => {
    const rot = (hash(it.id + p.id) % 9) - 4;
    const mk = it.id + ":" + p.id;
    const fresh = !seenMarks.has(mk);
    seenMarks.add(mk);
    return `<span class="mark${fresh ? " new" : ""}" style="--ink:${p.ink};--r:${rot}deg">${esc(initials(p))}${S.portions[it.id]?.[p.id] ? `<small>${fracLabel(S.portions[it.id][p.id])}</small>` : c[p.id] > 1 ? `<small>×${c[p.id]}</small>` : ""}</span>`;
  }).join("");
  const mine = act && c[act] > 0;
  const inner = `
    <span class="l-qty">${it.qty > 1 ? it.qty : ""}</span>
    <span class="l-name">${esc(it.name)}${it.shared && claimers.length < 2 ? ` <span class="l-tag">shared</span>` : ""}</span>
    <span class="l-marks">${marks}</span>
    <span class="l-price">${money(it.price)}</span>`;
  const body = act
    ? `<button class="l-hit" data-action="claim" data-id="${it.id}" aria-pressed="${!!mine}">${inner}</button>`
    : `<div class="l-hit">${inner}</div>`;
  const stepper = act && mine && it.qty > 1
    ? `<div class="l-units" style="--ink:${inkOf(act)}">
        <button data-action="units" data-id="${it.id}" data-d="-1" aria-label="One fewer ${esc(it.name)}">−</button>
        <span>${esc(person(act).name)} had ${c[act]} of ${it.qty}</span>
        <button data-action="units" data-id="${it.id}" data-d="1" aria-label="One more ${esc(it.name)}" ${c[act] >= it.qty ? "disabled" : ""}>+</button>
      </div>`
    : "";
  const others = S.people.some((p) => p.id !== act && c[p.id] > 0) && !marksHidden();
  let portionRow = "";
  if (act && mine && it.qty === 1 && others && it.shared) {
    const mineP = S.portions[it.id]?.[act] || 0;
    const name = esc(person(act).name);
    portionRow = openPortion === it.id
      ? `<div class="l-portion open" style="--ink:${inkOf(act)}" role="group" aria-label="${name}'s share of ${esc(it.name)}">
          <button data-action="portion" data-id="${it.id}" data-f="0" aria-pressed="${!mineP}">even</button>
          ${FRACTIONS.map(([v, l]) => `<button data-action="portion" data-id="${it.id}" data-f="${v}" aria-pressed="${Math.abs(mineP - v) < 0.01}">${l}</button>`).join("")}
        </div>`
      : `<div class="l-portion" style="--ink:${inkOf(act)}">
          <span>${name}: ${mineP ? `had ${fracLabel(mineP)}` : "split evenly"}</span>
          <button class="l-portion-change" data-action="portion-open" data-id="${it.id}">uneven?</button>
        </div>`;
  }
  const ck = it.id + ":" + flag?.type;
  const drawn = seenCircles.has(ck);
  if (flag) seenCircles.add(ck);
  const circle = flag
    ? `<svg class="circle${drawn ? " drawn" : ""}" viewBox="0 0 300 44" preserveAspectRatio="none" aria-hidden="true"><path d="M14 30C4 14 52 4 150 4s150 6 146 20c-4 16-90 18-150 17C60 40 8 38 8 22c0-6 8-10 20-13"/></svg>`
    : "";
  const flash = flashLines.has(it.id);
  return `<li class="line${mine ? " mine" : ""}${flag ? " flagged" : ""}${flash ? " flash" : ""}" style="--ink:${act ? inkOf(act) : "var(--ui)"}">${body}${stepper}${portionRow}${circle}</li>`;
}

// The stamp should slam once, when the last person pays, not on every render.
let wasSettled = false;
function justSettled() {
  const fresh = !wasSettled;
  wasSettled = true;
  return fresh;
}

// ---------- stage ----------
function renderSteps() {
  const at = STEPS.findIndex((s) => s.id === S.step);
  $("#steps").innerHTML = `<ol>${STEPS.map((s, i) => `
    <li><button data-action="goto" data-step="${s.id}" ${canVisit(s.id) ? "" : "disabled"}
      ${s.id === S.step ? 'aria-current="step"' : ""} class="${i < at ? "done" : ""}">
      <span class="step-n">${i + 1}</span>${s.label}</button></li>`).join("")}</ol>`;
  const cur = $("#steps [aria-current]");
  const ol = $("#steps ol");
  if (cur && ol.scrollWidth > ol.clientWidth) ol.scrollLeft = cur.offsetLeft - ol.clientWidth / 2 + cur.offsetWidth / 2;
}

function renderStage() {
  const stage = $("#stage");
  const after = $("#after");
  const views = { receipt: stageReceipt, table: stageTable, claim: stageClaim, tip: stageTip, settle: stageSettle };
  const out = views[S.step]();
  const [top, rest] = Array.isArray(out) ? out : [out, ""];
  stage.innerHTML = top;
  after.innerHTML = rest;
  document.body.dataset.step = S.step;
  if (lastStep !== S.step) {
    // Push forward, slide back: direction follows the step order.
    const idx = (id) => STEPS.findIndex((x) => x.id === id);
    const dir = lastStep && idx(S.step) < idx(lastStep) ? "enter-back" : "enter";
    for (const el of [stage, after]) {
      el.classList.remove("enter", "enter-back");
      void el.offsetWidth;
      el.classList.add(dir);
      clearTimeout(el.enterTimer);
      el.enterTimer = setTimeout(() => el.classList.remove("enter", "enter-back"), 800);
    }
    lastStep = S.step;
  }
}

function next(step, label, { disabled = false, note = "" } = {}) {
  return `<div class="next">
    <button class="btn btn-go" data-action="goto" data-step="${step}" ${disabled ? "disabled" : ""}>${label}<span aria-hidden="true">→</span></button>
    ${note ? `<p class="next-note">${note}</p>` : ""}
  </div>`;
}

function stageReceipt() {
  if (ocr?.status === "reading") {
    const pct = Math.round((ocr.progress || 0) * 100);
    return `
      <h2>Reading the receipt</h2>
      <p class="lede">Finding each line and its price. The first read takes a few extra seconds while the reader loads.</p>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
      <p class="progress-label">${readerReady ? `${pct}% read` : "Getting the reader ready…"}</p>`;
  }
  if (!S.items.length && !S.manual) {
    return `
      <h2>Split the check from a photo</h2>
      <p class="lede">Snap the receipt. Everyone claims what they ordered, one person picks the tip, and Chit works out who owes what, to the cent. No accounts, nothing to install.</p>
      ${touch.matches ? `
      <label class="shoot" for="camera">
        <span class="shoot-lens" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M12 6h24v36l-4-3-4 3-4-3-4 3-4-3-4 3z"/><path d="M18 16h12M18 22h8M18 28h10"/></svg></span>
        <span><span class="drop-main">Take a photo of the receipt</span>
        <span class="drop-sub">Lay it flat in good light.</span></span>
      </label>
      <label class="btn btn-quiet from-photos" for="file">Choose from your photos</label>` : `
      <label class="drop" for="file" id="drop">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 6h24v36l-4-3-4 3-4-3-4 3-4-3-4 3z"/><path d="M18 16h12M18 22h8M18 28h10"/></svg>
        <span class="drop-main">Drop a receipt photo here</span>
        <span class="drop-sub">or <u>choose a file</u>. Flat, bright photos read best.</span>
      </label>`}
      ${ocr?.status === "error" ? `<p class="err" role="alert">${esc(ocr.message)}</p>` : ""}
      <div class="alt">
        <button class="btn btn-quiet" data-action="sample">Try a sample receipt</button>
        <button class="btn btn-quiet" data-action="manual">Type it in instead</button>
      </div>
      <button class="join-cta" data-action="join-open"><span>Someone already scanned it?</span><b>Join their bill with a code</b><span aria-hidden="true">→</span></button>`;
  }
  const sum = S.items.reduce((a, i) => a + i.price, 0);
  const printedTotal = sum + S.tax + S.fees.reduce((a, f) => a + f.amount, 0);
  const checks = [];
  if (S.printed.subtotal != null) {
    checks.push(sum === S.printed.subtotal
      ? { ok: true, text: `Lines add up to the printed subtotal, ${dollars(sum)}.` }
      : { ok: false, text: `Lines add up to ${dollars(sum)}, but the receipt's subtotal says ${dollars(S.printed.subtotal)}. A line may be missing or misread.` });
  }
  if (S.printed.total != null) {
    checks.push(printedTotal === S.printed.total
      ? { ok: true, text: `Tax and fees match the printed total, ${dollars(printedTotal)}.` }
      : { ok: false, text: `With tax and fees this comes to ${dollars(printedTotal)}; the receipt's total is ${dollars(S.printed.total)}.` });
  }
  return `
    <h2>${S.manual && !photo ? "Type in the receipt" : "Check what Chit read"}</h2>
    <p class="lede">${S.manual && !photo
      ? "Fill in each line on the paper. Press Enter to finish a field."
      : `Found ${S.items.length} line${S.items.length === 1 ? "" : "s"}. Anything wrong? Click it on the paper and fix it.`}</p>
    ${checks.length ? `<ul class="checks">${checks.map((c) => `<li class="${c.ok ? "ok" : "warn"}">${c.ok ? tick() : bang()}<span>${c.text}</span></li>`).join("")}</ul>` : ""}
    ${photo ? `<details class="photo"><summary>Compare with the photo</summary><img src="${photo}" alt="Receipt photo"></details>` : ""}
    ${next("table", "Next: who's at the table", { disabled: !S.items.length })}
    <button class="btn-link" data-action="rescan">Use a different receipt</button>`;
}

const tick = () => `<svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 11l4 4 8-10"/></svg>`;
const bang = () => `<svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v8M10 15.5v.5"/></svg>`;
const scribble = (color) => `<svg class="scribble" viewBox="0 0 28 14" style="--ink:${color}" aria-hidden="true"><path d="M2 10c4-8 6-8 8-2s4 6 7-1 5-5 9-3"/></svg>`;

function stageTable() {
  const hint = S.guests && S.people.length < S.guests ? ` The receipt says ${S.guests} guests.` : "";
  return `
    <h2>Who's at the table?</h2>
    <p class="lede">Everyone gets their own pen color, so you can see who claimed what on the receipt.${hint}</p>
    <form class="add" data-form="add-person">
      <input name="name" data-key="add-person" placeholder="Add a name" autocomplete="off" maxlength="24" aria-label="Name">
      <button class="btn">Add</button>
    </form>
    <ul class="people">${S.people.map((p) => `
      <li style="--ink:${p.ink}">
        ${scribble(p.ink)}
        <input class="p-name" data-key="pn-${p.id}" data-field="person-name" data-id="${p.id}" value="${esc(p.name)}" aria-label="Name">
        <button class="payer${S.payer === p.id ? " on" : ""}" data-action="payer" data-id="${p.id}" aria-pressed="${S.payer === p.id}">${S.payer === p.id ? "Paid the bill" : "Paid?"}</button>
        <button class="l-del" data-action="del-person" data-id="${p.id}" aria-label="Remove ${esc(p.name)}">×</button>
      </li>`).join("")}
    </ul>
    ${S.people.length ? `<p class="hint">Mark whoever put down their card. Everyone else will owe them.</p>` : ""}
    ${live ? "" : `
    <section class="invite">
      <div>
        <h3>Everyone on their own phone</h3>
        <p class="hint">Start a live bill and send the link. Friends join with a code, add themselves, and claim what they had. Everyone sees the same receipt update live.</p>
      </div>
      <button class="btn" data-action="go-live">Start a live bill</button>
    </section>`}
    ${next("claim", "Next: claim what you had", {
      disabled: S.people.length < 2,
      note: S.people.length < 2 ? "Add at least two people." : "",
    })}`;
}

function stageClaim() {
  if (live) S.claimMode = "together";
  const mode = S.claimMode;
  const open = issues().length;
  const seg = `
    <div class="seg" role="radiogroup" aria-label="How to claim">
      <button role="radio" aria-checked="${mode === "together"}" data-action="mode" data-mode="together">
        <b>Together</b><span>Everyone around one screen</span></button>
      <button role="radio" aria-checked="${mode === "private"}" data-action="mode" data-mode="private">
        <b>Pass the phone</b><span>Each person marks theirs privately</span></button>
    </div>`;
  const toTip = (note = true) => `<button class="btn btn-go" data-action="goto" data-step="tip">Next: tip<span aria-hidden="true">→</span></button>
    ${note && open ? `<p class="next-note">${open} unsorted line${open === 1 ? "" : "s"} will be split evenly.</p>` : ""}`;

  let top = "";
  let rest = "";
  if (mode === "together") {
    const action = !S.claimChecked && open
      ? `<button class="btn btn-go" data-action="check-claims">Done claiming<span aria-hidden="true">→</span></button>`
      : toTip(false);
    top = `
      <p class="hint hint-top">${live
        ? "Claiming for someone without their phone? Pick their name first. Shared a dish? Everyone who had some taps it, then marks it shared."
        : "Pick a name, then tap what they had on the receipt. Shared a dish? Everyone who had some taps it, then marks it shared."}</p>
      <div class="dock">
        <div class="dock-chips">${S.people.map((p) => `
          <button class="chip" style="--ink:${p.ink}" data-action="active" data-id="${p.id}" aria-pressed="${S.active === p.id}">${scribble(p.ink)}${esc(p.name)}${live?.me === p.id ? " <small>(you)</small>" : ""}</button>`).join("")}
        </div>
        <div class="dock-go">${action}</div>
      </div>`;
    rest = `${issuesHTML(visibleIssues(), S.claimChecked)}${runningHTML()}
      ${S.claimChecked && open ? `<p class="next-note note-after">${open} unsorted line${open === 1 ? "" : "s"} will be split evenly.</p>` : ""}`;
  } else {
    const p = S.priv;
    if (!p.started) {
      top = `
        <p class="lede">The phone goes around the table. Each person taps what they had, and nobody sees anyone else's marks. At the end, Chit shows only the lines that don't add up.</p>
        <ol class="order">${S.people.map((q) => `<li style="--ink:${q.ink}">${scribble(q.ink)}${esc(q.name)}</li>`).join("")}</ol>
        <button class="btn btn-go" data-action="priv-start">Start with ${esc(S.people[0].name)}<span aria-hidden="true">→</span></button>`;
    } else if (!p.done) {
      const me = person(privateClaimer());
      const mine = S.items.filter((it) => (S.claims[it.id] || {})[me.id] > 0);
      const last = p.index === S.people.length - 1;
      top = `
        <div class="dock dock-turn" style="--ink:${me.ink}">
          <div class="turn">
            <p class="turn-name">${esc(me.name)},</p>
            <p class="turn-ask">tap everything you had.</p>
            <p class="turn-count">${mine.length ? `${mine.length} line${mine.length === 1 ? "" : "s"} marked` : "Nothing marked yet"}</p>
          </div>
          <div class="dock-go"><button class="btn btn-go" data-action="priv-next">${last ? "Done, that's everyone" : `Done, pass to ${esc(S.people[p.index + 1].name)}`}<span aria-hidden="true">→</span></button></div>
        </div>
        <ol class="order">${S.people.map((q, i) => `<li class="${i < p.index ? "done" : i === p.index ? "now" : ""}" style="--ink:${q.ink}">${scribble(q.ink)}${esc(q.name)}</li>`).join("")}</ol>`;
    } else if (!p.revealed) {
      top = `
        <p class="lede">Everyone has marked their items. Ready to see where things don't add up?</p>
        <button class="btn btn-go" data-action="reveal">Reveal the receipt</button>`;
    } else {
      top = `<div class="next next-top">${toTip()}</div>`;
      rest = `${issuesHTML(issues(), true)}${runningHTML()}
        <button class="btn-link" data-action="priv-restart">Pass the phone around again</button>`;
    }
  }
  const lead = live
    ? `<p class="lede live-lede">${person(live.me) ? `Tap what you had, ${esc(person(live.me).name)}.` : "Tap what you had."} Everyone sees marks as they happen.</p>`
    : seg;
  return [`<h2>Who had what?</h2>${lead}<div class="claim-body">${top}</div>`, rest];
}

function issuesHTML(list, final) {
  if (!list.length) {
    const left = issues().length;
    return final || !left
      ? `<p class="settled">${tick()}Every line is accounted for.</p>`
      : `<p class="hint">${left} line${left === 1 ? "" : "s"} still unclaimed.</p>`;
  }
  const joined = (ids) => {
    const n = ids.map((id) => esc(person(id).name));
    return n.length < 3 ? n.join(" and ") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
  };
  return `
    <h3 class="issues-title">${list.length} line${list.length === 1 ? "" : "s"} to sort out</h3>
    <ul class="issues">${list.map(({ type, item, claimers, units }) => {
      let title, actions;
      if (type === "unclaimed") {
        title = `Nobody claimed ${esc(item.name)}`;
        actions = `<button class="btn btn-sm" data-action="fix-everyone" data-id="${item.id}">Split between everyone</button>
          <span class="or">or give it to</span>
          ${S.people.map((p) => `<button class="chip chip-sm" style="--ink:${p.ink}" data-action="fix-give" data-id="${item.id}" data-pid="${p.id}">${esc(p.name)}</button>`).join("")}`;
      } else if (type === "over") {
        title = item.qty > 1
          ? `${units} ${esc(item.name)} claimed, but there were ${item.qty}`
          : `${joined(claimers)} ${claimers.length === 2 ? "both" : "all"} claimed ${esc(item.name)}`;
        actions = `<button class="btn btn-sm" data-action="fix-shared" data-id="${item.id}">They shared it</button>
          ${claimers.map((id) => `<button class="chip chip-sm" style="--ink:${inkOf(id)}" data-action="fix-give" data-id="${item.id}" data-pid="${id}">Only ${esc(person(id).name)}</button>`).join("")}`;
      } else if (type === "share-over" || type === "share-under") {
        const pct = Math.round((list.find((i) => i.item === item).sum || 0) * 100);
        title = type === "share-over"
          ? `Shares of ${esc(item.name)} add up to more than all of it`
          : `Shares of ${esc(item.name)} only cover ${pct}%`;
        actions = `<button class="btn btn-sm" data-action="portion-clear" data-id="${item.id}">Split it evenly instead</button>`;
      } else {
        title = `Only ${units} of ${item.qty} ${esc(item.name)} claimed`;
        actions = `<button class="btn btn-sm" data-action="fix-shared" data-id="${item.id}">${joined(claimers)} ${claimers.length === 1 ? "had" : "split"} all ${item.qty}</button>
          <button class="btn btn-sm btn-quiet" data-action="fix-rest" data-id="${item.id}">Split the rest with everyone</button>`;
      }
      return `<li class="issue"><div class="issue-head"><span>${title}</span><span class="num">${dollars(item.price)}</span></div><div class="issue-actions">${actions}</div></li>`;
    }).join("")}</ul>`;
}

// Only what people have actually tapped, so the bars fill as claiming happens.
function claimedSoFar() {
  const out = Object.fromEntries(S.people.map((p) => [p.id, 0]));
  for (const it of S.items) {
    const c = S.claims[it.id] || {};
    const ids = S.people.map((p) => p.id).filter((id) => c[id] > 0);
    const portion = S.portions[it.id] || {};
    if (ids.some((id) => portion[id] > 0)) {
      const share = portionShares(ids, portion);
      ids.forEach((id) => { out[id] += it.price * share[id]; });
      continue;
    }
    const units = ids.reduce((a, id) => a + c[id], 0);
    const pool = it.shared || units > it.qty ? units : it.qty;
    ids.forEach((id) => { out[id] += (it.price * c[id]) / pool; });
    if (it.restEven && !it.shared && units < it.qty) {
      const each = (it.price * (it.qty - units)) / it.qty / S.people.length;
      S.people.forEach((p) => { out[p.id] += each; });
    }
  }
  return out;
}

function runningHTML() {
  const got = claimedSoFar();
  const subtotal = S.items.reduce((a, i) => a + i.price, 0);
  const claimed = Object.values(got).reduce((a, b) => a + b, 0);
  return `
    <h3 class="issues-title">Claimed so far <span class="muted-num num">${dollars(Math.round(claimed))} of ${dollars(subtotal)}</span></h3>
    <ul class="running">${S.people.map((p) => {
      const v = Math.round(got[p.id]);
      const pct = subtotal ? (v / subtotal) * 100 : 0;
      return `<li style="--ink:${p.ink}"><span class="run-name">${esc(p.name)}</span>
        <span class="run-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
        <span class="num" data-tween="run-${p.id}" data-val="${v}">${dollars(v)}</span></li>`;
    }).join("")}</ul>`;
}

let lastPct = null;
function stageTip() {
  queueMicrotask(() => { lastPct = S.tip.percent; });
  const sp = split();
  const t = S.tip;
  if (!person(t.picker)) t.picker = S.payer ?? S.people[0].id;
  const picker = person(t.picker);
  const base = t.base === "posttax" ? sp.subtotal + sp.tax : sp.subtotal;
  const effPct = base ? (sp.tipTotal / base) * 100 : 0;
  const presets = [15, 18, 20, 22, 25];
  const locked = live && live.me !== t.picker;
  const off = locked ? "disabled" : "";
  return `
    <h2>Tip</h2>
    <p class="lede">One person picks it, so nobody has to negotiate at the table.</p>
    <p class="label">Who's picking?</p>
    <div class="chips">${S.people.map((p) => `
      <button class="chip" style="--ink:${p.ink}" data-action="picker" data-id="${p.id}" aria-pressed="${t.picker === p.id}">${scribble(p.ink)}${esc(p.name)}</button>`).join("")}
    </div>

    <section class="tipcard" style="--ink:${picker.ink}">
      <p class="tip-who"><span class="ink-name">${esc(picker.name)}</span> is picking${locked ? ". It updates here as they choose." : ""}</p>
      <div class="tip-readout">
        <span class="tip-pct num${S.tip.percent !== lastPct ? " pop" : ""}">${t.mode === "percent" ? t.percent : effPct.toFixed(1)}<small>%</small></span>
        <span class="tip-amt"><span class="num" data-tween="tipamt" data-val="${sp.tipTotal}">${dollars(sp.tipTotal)}</span> on ${dollars(base)}</span>
      </div>
      <div class="presets" role="group" aria-label="Tip percentage">${presets.map((n) => `
        <button data-action="tip-pct" data-pct="${n}" aria-pressed="${t.mode === "percent" && t.percent === n}" ${off}>${n}%</button>`).join("")}
      </div>
      <div class="custom">
        <label>Custom %<input class="num" data-key="tip-custom" data-field="tip-percent" inputmode="decimal" ${off} value="${t.mode === "percent" && !presets.includes(t.percent) ? t.percent : ""}" placeholder="e.g. 19"></label>
        <label>Exact amount<input class="num" data-key="tip-amount" data-field="tip-amount" inputmode="decimal" ${off} value="${t.mode === "amount" ? money(t.amount) : ""}" placeholder="0.00"></label>
      </div>
    </section>

    <div class="opts">
      <label class="opt">
        <input type="checkbox" data-field="tip-base" ${t.base === "pretax" ? "checked" : ""} ${off}>
        <span><b>Tip on the amount before tax</b><small>Tips on ${dollars(sp.subtotal)} instead of ${dollars(sp.subtotal + sp.tax)}. Common in the US.</small></span>
      </label>
      <div class="opt-row" role="radiogroup" aria-label="How to split the tip">
        <span class="label">Split the tip</span>
        <button class="pill" role="radio" data-action="tip-split" data-split="proportional" aria-checked="${t.split === "proportional"}" ${off}>By what each person ordered</button>
        <button class="pill" role="radio" data-action="tip-split" data-split="even" aria-checked="${t.split === "even"}" ${off}>Evenly</button>
      </div>
    </div>
    <p class="grand">Bill with tip <span class="num" data-tween="grand" data-val="${sp.grandTotal}">${dollars(sp.grandTotal)}</span></p>
    ${next("settle", "Next: settle up")}`;
}

function stageSettle() {
  const sp = split();
  if (!person(S.payer)) S.payer = S.people[0].id;
  const payer = person(S.payer);
  const rows = sp.rows.map((r) => ({ ...r, p: person(r.id) }));
  const owed = rows.filter((r) => r.id !== payer.id).reduce((a, r) => a + r.total, 0);
  const collected = rows.filter((r) => r.id !== payer.id && S.paid.includes(r.id)).reduce((a, r) => a + r.total, 0);
  const sumCheck = rows.reduce((a, r) => a + r.total, 0) === sp.grandTotal;

  return `
    <h2 class="settle-head"><span class="ink-name" style="--ink:${payer.ink}">${esc(payer.name)}</span> paid <span class="num" data-tween="grand" data-val="${sp.grandTotal}">${dollars(sp.grandTotal)}</span></h2>
    ${(() => {
      const mine = live && live.me !== payer.id && rows.find((r) => r.id === live.me);
      return mine ? `<p class="you-owe" style="--ink:${payer.ink}">${S.paid.includes(mine.id) ? "You paid" : "You owe"} ${esc(payer.name)} <span class="num" data-tween="you" data-val="${mine.total}">${dollars(mine.total)}</span></p>` : "";
    })()}
    <p class="lede">${owed && collected === owed
      ? `Everyone's square with ${esc(payer.name)}.`
      : `Here's what everyone owes ${esc(payer.name)}.${collected ? ` ${dollars(collected)} of ${dollars(owed)} collected so far.` : ""}`}</p>
    ${owed && collected === owed ? `<div class="stamp-wrap" aria-hidden="true"><span class="settled-stamp${justSettled() ? " slam" : ""}">Settled</span></div>` : ""}
    <ul class="ious">${rows.map((r) => {
      const isPayer = r.id === payer.id;
      const paid = S.paid.includes(r.id);
      const parts = [["Food", r.food], ["Tax", r.tax], ["Fees", r.fees], ["Tip", r.tip], ["Covering", r.cover]]
        .filter(([, v]) => v).map(([k, v]) => `${k} ${money(v)}`).join(" · ");
      return `
      <li class="iou${paid ? " paid" : ""}${isPayer ? " is-payer" : ""}${live?.me === r.id ? " is-me" : ""}" style="--ink:${r.p.ink}">
        <div class="iou-top">
          <span class="iou-name">${esc(r.p.name)}${live?.me === r.id ? `<small class="you-tag">you</small>` : ""}</span>
          <span class="iou-amt num" data-tween="iou-${r.id}" data-val="${r.total}">${dollars(r.total)}</span>
        </div>
        <div class="iou-sub">
          <span class="iou-parts">${S.covered.includes(r.id) ? "On the house tonight" : parts || "Nothing claimed"}</span>
          ${isPayer
            ? `<span class="iou-tag">Paid the bill</span>`
            : `<button class="btn btn-sm ${paid ? "btn-quiet" : ""}" data-action="paid" data-id="${r.id}" aria-pressed="${paid}">${paid ? "Paid" : "Mark paid"}</button>`}
        </div>
        ${r.items.length ? `<details><summary>What ${esc(r.p.name)} had</summary><ul>${r.items.map((i) => {
          const it = S.items.find((x) => x.id === i.id);
          const sharers = Object.values(S.claims[it.id] || {}).filter((v) => v > 0).length;
          const note = i.portion ? fracLabel(i.portion) : it.qty > 1 && !it.shared && sharers ? `${i.units} of ${it.qty}` : (sharers !== 1 || it.shared ? "shared" : "");
          return `<li><span>${esc(i.name)}${note ? ` <small>${note}</small>` : ""}</span><span class="num">${money(Math.round(i.cents))}</span></li>`;
        }).join("")}</ul></details>` : ""}
        <svg class="strike" viewBox="0 0 400 20" preserveAspectRatio="none" aria-hidden="true"><path d="M4 12C90 6 200 14 396 7"/></svg>
      </li>`;
    }).join("")}</ul>
    ${sumCheck ? `<p class="settled">${tick()}Shares add up to ${dollars(sp.grandTotal)}, to the cent.</p>` : ""}

    <section class="treat">
      <h3>Treating someone?</h3>
      <p class="hint">Their share spreads across everyone else, in proportion to what each person owes.</p>
      <div class="chips">${S.people.map((p) => `
        <button class="chip" style="--ink:${p.ink}" data-action="cover" data-id="${p.id}" aria-pressed="${S.covered.includes(p.id)}">${scribble(p.ink)}Cover ${esc(p.name)}</button>`).join("")}
      </div>
    </section>
    <div class="next">
      <button class="btn btn-go" data-action="copy">Copy summary</button>
      <button class="btn btn-quiet" data-action="new">Start a new bill</button>
    </div>`;
}

function renderOverlay() {
  const o = $("#overlay");
  const id = privateClaimer();
  renderLivePill();
  if (joining || liveSheet) {
    o.innerHTML = joining ? joinSheetHTML() : liveSheetHTML();
    if (!joining) drawQR();
    document.body.classList.add("locked");
    return;
  }
  if (S.step === "claim" && id && S.priv.handoff && !live) {
    const p = person(id);
    o.innerHTML = `
      <div class="handoff" role="dialog" aria-modal="true" aria-labelledby="handoff-name" style="--ink:${p.ink}">
        <p class="handoff-eyebrow">Pass the phone to</p>
        <p class="handoff-name" id="handoff-name">${esc(p.name)}</p>
        <p class="handoff-note">Everyone else's marks stay hidden until the reveal.</p>
        <button class="btn btn-go btn-big" data-action="priv-go">I'm ${esc(p.name)}</button>
        <button class="btn-link" data-action="priv-skip">${esc(p.name)} isn't here, skip</button>
      </div>`;
    document.body.classList.add("locked");
    $(".handoff .btn-big")?.focus();
  } else {
    o.innerHTML = "";
    document.body.classList.remove("locked");
  }
}

// Count money up or down to its new value instead of snapping.
const tweened = new Map();
function tween() {
  document.querySelectorAll("[data-tween]").forEach((el) => {
    const key = el.dataset.tween;
    const to = Number(el.dataset.val);
    const from = tweened.get(key);
    tweened.set(key, to);
    if (from == null || from === to || reduced.matches) return;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 420);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = dollars(Math.round(from + (to - from) * e));
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function render() {
  const a = document.activeElement;
  const key = a?.dataset?.key;
  let sel = null;
  try { sel = key && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null; } catch {}
  renderSteps();
  renderReceipt();
  renderStage();
  renderOverlay();
  if (key) {
    const el = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      try { if (sel) el.setSelectionRange(...sel); } catch {}
    }
  }
  tween();
  revealing = false;
  flashLines.clear();
  save();
  syncOut();
}

// The async clipboard API only exists on https or localhost. A phone reaching
// this demo over the local network is neither, so fall back to execCommand.
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    ok ? resolve() : reject(new Error("copy"));
  });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 2600);
}

// ---------- receipt reading ----------
// The reader (engine + English model, ~5 MB) starts loading as soon as the app
// opens, so it's warm by the time someone has framed the photo.
let reader = null;
let readerReady = false;
let readerProgress = null;
function warmReader() {
  if (reader || !window.Tesseract) return reader;
  reader = window.Tesseract.createWorker("eng", 1, { logger: (m) => readerProgress?.(m) })
    .then((w) => {
      readerReady = true;
      return w;
    })
    .catch((e) => {
      reader = null;
      throw e;
    });
  reader.catch(() => {});
  return reader;
}
async function toCanvas(src) {
  // img.decode() can stall when the browser deprioritizes the tab; the plain
  // load event always fires.
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
  const w = img.naturalWidth;
  // ~1500px wide is plenty for receipt text; bigger only makes OCR slower.
  const scale = w < 1200 ? Math.min(2, 1500 / w) : Math.min(1, 1500 / w);
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const g = c.getContext("2d");
  g.filter = "grayscale(1) contrast(1.35)";
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function loadParsed(r) {
  const keep = { people: S.people, payer: S.payer, claimMode: S.claimMode };
  S = { ...blank(), ...keep };
  S.merchant = r.merchant || "";
  S.items = r.items.map((i) => ({ id: uid(), name: i.name, qty: i.qty, price: i.price, shared: false }));
  S.tax = r.tax || 0;
  S.fees = (r.fees || []).map((f) => ({ id: uid(), ...f }));
  S.printed = { subtotal: r.subtotal ?? null, total: r.total ?? null };
  S.guests = r.guests ?? null;
  shown.clear();
}

async function readReceipt(src, fallback) {
  photo = src;
  ocr = { status: "reading", progress: 0 };
  render();
  try {
    const worker = warmReader();
    if (!worker) throw new Error("reader");
    const canvas = await toCanvas(src);
    readerProgress = (m) => {
      const reading = m.status === "recognizing text";
      ocr.progress = reading ? m.progress : 0;
      const pct = Math.round(ocr.progress * 100);
      const fill = $(".progress-fill");
      if (fill) fill.style.width = pct + "%";
      const label = $(".progress-label");
      if (label) label.textContent = reading ? `${pct}% read` : "Getting the reader ready…";
    };
    const w = await worker;
    const { data } = await w.recognize(canvas);
    readerProgress = null;
    const r = parseReceipt(data.text);
    if (!r.items.length) throw new Error("empty");
    loadParsed(r);
    ocr = null;
    printing = true;
    render();
  } catch (e) {
    ocr = null;
    readerProgress = null;
    if (fallback) {
      loadParsed(fallback);
      printing = true;
      render();
      toast("The text reader didn't load, so the sample was typed in for you.");
      return;
    }
    photo = null;
    ocr = {
      status: "error",
      message: e.message === "empty"
        ? "No priced lines found in that photo. Try a flatter, brighter shot, or type the receipt in."
        : "The text reader didn't load. Check your internet connection, or type the receipt in.",
    };
    render();
  }
}

function readFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    toast("That isn't an image. Try a JPG or PNG photo.");
    return;
  }
  readReceipt(URL.createObjectURL(file));
}

// ---------- live sync ----------
function saveLive() {
  try { live ? localStorage.setItem(LIVE_KEY, JSON.stringify(live)) : localStorage.removeItem(LIVE_KEY); } catch {}
}

function toShared() {
  const m = {};
  m.bill = {
    merchant: S.merchant,
    items: S.items.map(({ id, name, qty, price }) => ({ id, name, qty, price })),
    tax: S.tax,
    fees: S.fees,
    printed: S.printed || { subtotal: null, total: null },
    guests: S.guests ?? null,
  };
  for (const p of S.people) m["p:" + p.id] = { name: p.name, ink: p.ink, at: p.at || 0 };
  if (S.payer) m.payer = S.payer;
  for (const it of S.items) {
    if (it.shared) m["sh:" + it.id] = true;
    if (it.restEven) m["re:" + it.id] = true;
    for (const [pid, u] of Object.entries(S.claims[it.id] || {})) if (u > 0) m[`c:${it.id}:${pid}`] = u;
    for (const [pid, f] of Object.entries(S.portions[it.id] || {})) if (f > 0) m[`f:${it.id}:${pid}`] = f;
  }
  m.tip = S.tip;
  if (S.covered.length) m.cov = [...S.covered].sort();
  for (const pid of S.paid) m["pd:" + pid] = true;
  if (S.claimChecked) m.checked = true;
  if (live?.host) m.step = S.step;
  // A deep copy: S keeps mutating its objects in place, and the last-synced
  // snapshot must not change along with it or edits would never look new.
  return JSON.parse(JSON.stringify(m));
}

function fromShared(d) {
  const b = d.bill || {};
  S.merchant = b.merchant || "";
  S.tax = b.tax || 0;
  S.fees = b.fees || [];
  S.printed = b.printed || { subtotal: null, total: null };
  S.guests = b.guests ?? null;
  S.items = (b.items || []).map((i) => ({ ...i, shared: !!d["sh:" + i.id], restEven: !!d["re:" + i.id] }));
  S.people = Object.entries(d)
    .filter(([k, v]) => k.startsWith("p:") && v)
    .map(([k, v]) => ({ id: k.slice(2), ...v }))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  S.payer = d.payer ?? S.people[0]?.id ?? null;
  S.claims = {};
  S.portions = {};
  for (const [k, v] of Object.entries(d)) {
    if (!k.startsWith("c:") && !k.startsWith("f:")) continue;
    const [, iid, pid] = k.split(":");
    (k[0] === "c" ? (S.claims[iid] ||= {}) : (S.portions[iid] ||= {}))[pid] = v;
  }
  if (d.tip) S.tip = { ...S.tip, ...d.tip };
  S.covered = d.cov || [];
  S.paid = Object.keys(d).filter((k) => k.startsWith("pd:")).map((k) => k.slice(3));
  S.claimChecked = !!d.checked;
  S.claimMode = "together";
  if (S.items.length) S.manual = false;
  // Guests follow the host between steps, but can still look around.
  if (!live?.host && d.step && d.step !== lastHostStep) {
    lastHostStep = d.step;
    if (canVisit(d.step)) S.step = d.step;
  }
}

function syncOut() {
  // A joiner stays quiet until it has the bill, or it would publish a blank one.
  if (!room || !room.ready) return;
  const m = toShared();
  const changes = {};
  for (const k of Object.keys(m)) if (JSON.stringify(m[k]) !== JSON.stringify(lastShared[k])) changes[k] = m[k];
  for (const k of Object.keys(lastShared)) if (!(k in m)) changes[k] = null;
  lastShared = m;
  if (Object.keys(changes).length) room.set(changes);
}

function remoteChange(data) {
  const before = new Set();
  for (const [iid, c] of Object.entries(S.claims)) for (const [pid, u] of Object.entries(c)) if (u > 0) before.add(iid + ":" + pid);
  fromShared(data);
  lastShared = toShared();

  // Point at what just changed on someone else's phone.
  const added = [];
  for (const [iid, c] of Object.entries(S.claims)) {
    for (const [pid, u] of Object.entries(c)) {
      if (u > 0 && !before.has(iid + ":" + pid) && pid !== live?.me) {
        added.push([pid, iid]);
        flashLines.add(iid);
      }
    }
  }
  if (added.length && !joining) {
    const who = person(added[0][0]);
    const item = S.items.find((i) => i.id === added[0][1]);
    if (who && item) toast(added.length === 1 ? `${who.name} claimed ${item.name}` : `${who.name} claimed ${added.length} lines`);
  }
  if (joining && joining.phase === "finding" && S.items.length) joining.phase = "who";
  render();
}

function startRoom({ seed }) {
  room?.close();
  room = new Room({
    code: live.code,
    clientId,
    onChange: remoteChange,
    onStatus: () => renderLivePill(),
  });
  if (seed) {
    lastShared = toShared();
    room.seed(lastShared, seed === "fresh" ? Date.now() : 1);
  } else {
    lastShared = {};
  }
  room.connect();
}

function leaveLive() {
  room?.close();
  room = null;
  live = null;
  liveSheet = false;
  joining = null;
  saveLive();
}

// QR library loads only when someone opens the live sheet.
const qrCache = new Map();
let qrLib = null;
function drawQR() {
  const url = shareURL();
  if (qrCache.has(url)) return;
  qrLib ||= new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js";
    sc.onload = () => resolve(window.qrcode);
    sc.onerror = () => { qrLib = null; reject(new Error("qr")); };
    document.head.append(sc);
  });
  qrLib.then((qrcode) => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    qrCache.set(url, `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><path d="${d}"/></svg>`);
    const el = $("#qr");
    if (el && live && shareURL() === url) el.innerHTML = qrCache.get(url);
  }).catch(() => {
    const el = $("#qr");
    if (el) el.innerHTML = `<p class="hint">QR code needs a connection. Send the link instead.</p>`;
  });
}

function shareURL() {
  return `${location.origin}${location.pathname}#join=${live.code}`;
}

function renderLivePill() {
  const slot = $("#live-slot");
  if (!slot) return;
  if (!live) { slot.innerHTML = ""; return; }
  const status = room?.status || "connecting";
  const n = (room?.peerCount() || 0) + 1;
  slot.innerHTML = `
    <button class="live-pill ${status}" data-action="live-open" aria-label="Live bill ${live.code}, ${status}">
      <span class="live-dot" aria-hidden="true"></span>
      <span class="live-code num">${live.code}</span>
      <span class="live-n">${status === "live" ? `${n} phone${n === 1 ? "" : "s"}` : status === "connecting" ? "connecting" : "reconnecting"}</span>
    </button>`;
}

function liveSheetHTML() {
  const me = person(live.me);
  return `
    <div class="sheet" data-action="sheet-close">
      <div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="live-title" data-stop>
        <span class="sheet-grip" aria-hidden="true"></span>
        <p class="label" id="live-title">Live bill</p>
        <div class="qr-wrap">
          <div class="qr" id="qr" role="img" aria-label="QR code to join this bill">${qrCache.get(shareURL()) || ""}</div>
          <p class="qr-caption">Point a phone camera here to join</p>
        </div>
        <button class="btn btn-go btn-wide" data-action="share-link">Send the link<span aria-hidden="true">→</span></button>
        <p class="code-small">Can't scan? Code <span class="num">${live.code}</span></p>
        <p class="label sheet-label">This phone belongs to</p>
        <div class="chips">${S.people.map((p) => `
          <button class="chip" style="--ink:${p.ink}" data-action="set-me" data-id="${p.id}" aria-pressed="${live.me === p.id}">${scribble(p.ink)}${esc(p.name)}</button>`).join("")}
        </div>
        ${me ? "" : `<p class="hint">Pick your name so your taps count as yours.</p>`}
        <div class="sheet-foot">
          <button class="btn-link" data-action="leave-live">${live.host ? "Stop sharing on this phone" : "Leave this bill"}</button>
          <button class="btn btn-quiet" data-action="sheet-close">Done</button>
        </div>
      </div>
    </div>`;
}

function joinSheetHTML() {
  const j = joining;
  let body = "";
  if (j.phase === "enter") {
    body = `
      <h2 class="sheet-title">Join a bill</h2>
      <p class="hint">Type the code from whoever scanned the receipt.</p>
      <form class="join-form" data-form="join">
        <input class="code-input num" name="code" data-key="join-code" value="${esc(j.code || "")}" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="K7QM2" aria-label="Bill code">
        <button class="btn btn-go btn-wide">Join<span aria-hidden="true">→</span></button>
      </form>
      ${j.error ? `<p class="err" role="alert">${esc(j.error)}</p>` : ""}`;
  } else if (j.phase === "finding") {
    body = `
      <h2 class="sheet-title">Finding bill <span class="num">${esc(j.code)}</span></h2>
      <div class="finding" aria-hidden="true"><i></i><i></i><i></i></div>
      ${j.slow
        ? `<p class="hint">Still listening. Ask whoever started the bill to open Chit on their phone; you'll be let in as soon as they do. If the code might be wrong, try it again.</p>
           <button class="btn btn-quiet btn-wide" data-action="join-retype">Type the code again</button>`
        : `<p class="hint">Asking the phones already in it for the receipt.</p>`}`;
  } else {
    body = `
      <h2 class="sheet-title">Which one are you?</h2>
      <p class="hint">${esc(S.merchant || "The bill")} · ${S.items.length} lines</p>
      <div class="chips">${S.people.map((p) => `
        <button class="chip" style="--ink:${p.ink}" data-action="join-as" data-id="${p.id}">${scribble(p.ink)}${esc(p.name)}</button>`).join("")}
      </div>
      <form class="add join-add" data-form="join-new">
        <input name="name" data-key="join-name" placeholder="${S.people.length ? "Not listed? Add your name" : "Your name"}" autocomplete="given-name" maxlength="24" aria-label="Your name">
        <button class="btn">Add me</button>
      </form>`;
  }
  return `
    <div class="sheet" data-action="sheet-close">
      <div class="sheet-card" role="dialog" aria-modal="true" data-stop>
        <span class="sheet-grip" aria-hidden="true"></span>
        ${body}
        <div class="sheet-foot"><button class="btn-link" data-action="join-cancel">Cancel</button></div>
      </div>
    </div>`;
}

function beginJoin(code) {
  code = cleanCode(code);
  if (code.length !== 5) {
    joining = { phase: "enter", code, error: "Codes are 5 characters, like K7QM2." };
    return;
  }
  room?.close();
  S = blank();
  shown.clear();
  seenMarks.clear();
  seenCircles.clear();
  lastHostStep = null;
  live = { code, me: null, host: false };
  saveLive();
  joining = { phase: "finding", code };
  startRoom({ seed: false });
  // Keep listening for as long as the joiner wants: the host's phone may just
  // be asleep, and it sends the bill the moment Chit is opened again.
  clearTimeout(beginJoin.timer);
  beginJoin.timer = setTimeout(() => {
    if (joining?.phase !== "finding" || joining.code !== code) return;
    joining.slow = true;
    render();
  }, 12000);
}

function finishJoin(pid) {
  live.me = pid;
  saveLive();
  S.active = pid;
  joining = null;
  if (S.step === "receipt" || S.step === "table") S.step = canVisit("claim") ? "claim" : S.step;
  toast("You're in. Tap what you had.");
}

// A phone that slept or lost signal catches up when it comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && room && room.status !== "live") room.connect();
});

// ---------- actions ----------
function resetPrivate() {
  S.priv = { started: false, index: 0, handoff: true, done: false, revealed: false };
}

function advancePrivate() {
  const p = S.priv;
  if (p.index >= S.people.length - 1) { p.done = true; p.handoff = false; }
  else { p.index++; p.handoff = true; }
}

const actions = {
  "go-live": () => {
    live = { code: newCode(), me: S.payer && person(S.payer) ? S.payer : S.people[0]?.id ?? null, host: true };
    saveLive();
    startRoom({ seed: "fresh" });
    liveSheet = true;
  },
  "live-open": () => { liveSheet = true; },
  "sheet-close": (el, e) => {
    if (e && e.target.closest("[data-stop]") && !e.target.closest('[data-action="sheet-close"]:not(.sheet)')) return false;
    liveSheet = false;
    if (joining && joining.phase !== "who") joining = null;
  },
  "set-me": (el) => { live.me = el.dataset.id; S.active = live.me; saveLive(); },
  "leave-live": () => { leaveLive(); toast("This phone left the live bill. Your copy stays here."); },
  "share-link": () => {
    const url = shareURL();
    const text = "Join the bill on Chit";
    if (navigator.share) navigator.share({ title: "Chit", text, url }).catch(() => {});
    else copyText(url).then(() => toast("Link copied. Send it to the table."), () => toast(`Share this code: ${live.code}`));
    return false;
  },
  "join-open": () => { joining = { phase: "enter", code: "" }; requestAnimationFrame(() => $(".code-input")?.focus()); },
  "join-cancel": () => {
    if (joining?.phase !== "enter") leaveLive();
    joining = null;
  },
  "join-as": (el) => finishJoin(el.dataset.id),
  "join-retype": () => {
    const code = joining?.code || "";
    leaveLive();
    joining = { phase: "enter", code };
    requestAnimationFrame(() => $(".code-input")?.select());
  },
  goto: (el) => {
    if (!canVisit(el.dataset.step)) return false;
    S.step = el.dataset.step;
    window.scrollTo({ top: 0, behavior: reduced.matches ? "auto" : "smooth" });
  },
  sample: () => { readReceipt("assets/sample-receipt.jpg", SAMPLE); return false; },
  manual: () => {
    S.manual = true;
    S.items = [{ id: uid(), name: "", qty: 1, price: 0, shared: false }];
    requestAnimationFrame(() => $(".l-name")?.focus());
  },
  rescan: () => {
    S = { ...blank(), people: S.people, payer: S.payer };
    photo = null;
    ocr = null;
  },
  "add-line": () => {
    const id = uid();
    S.items.push({ id, name: "", qty: 1, price: 0, shared: false });
    requestAnimationFrame(() => document.querySelector(`[data-key="n-${id}"]`)?.focus());
  },
  "del-line": (el) => {
    S.items = S.items.filter((i) => i.id !== el.dataset.id);
    delete S.claims[el.dataset.id];
  },
  "add-fee": () => {
    const id = uid();
    S.fees.push({ id, name: "Service charge", amount: 0 });
    requestAnimationFrame(() => document.querySelector(`[data-key="fa-${id}"]`)?.select());
  },
  "del-fee": (el) => { S.fees = S.fees.filter((f) => f.id !== el.dataset.id); },
  payer: (el) => { S.payer = el.dataset.id; },
  "del-person": (el) => {
    const id = el.dataset.id;
    S.people = S.people.filter((p) => p.id !== id);
    Object.values(S.claims).forEach((c) => delete c[id]);
    if (S.payer === id) S.payer = S.people[0]?.id ?? null;
    S.covered = S.covered.filter((x) => x !== id);
    S.paid = S.paid.filter((x) => x !== id);
    resetPrivate();
  },
  mode: (el) => { S.claimMode = el.dataset.mode; S.claimChecked = false; },
  "check-claims": () => { S.claimChecked = true; },
  active: (el) => { S.active = el.dataset.id; },
  claim: (el) => {
    const who = activeClaimer();
    if (!who) return false;
    const c = (S.claims[el.dataset.id] ||= {});
    c[who] = c[who] > 0 ? 0 : 1;
    if (!c[who] && S.portions[el.dataset.id]) delete S.portions[el.dataset.id][who];
    navigator.vibrate?.(c[who] ? 8 : 4);
  },
  "portion-open": (el) => { openPortion = el.dataset.id; },
  portion: (el) => {
    const who = activeClaimer();
    const id = el.dataset.id;
    const f = Number(el.dataset.f);
    const p = (S.portions[id] ||= {});
    if (f) p[who] = f;
    else delete p[who];
    if (f) S.items.find((i) => i.id === id).shared = true;
    openPortion = null;
    navigator.vibrate?.(6);
  },
  "portion-clear": (el) => { delete S.portions[el.dataset.id]; },
  units: (el) => {
    const who = activeClaimer();
    const it = S.items.find((i) => i.id === el.dataset.id);
    const c = (S.claims[it.id] ||= {});
    c[who] = Math.max(0, Math.min(it.qty, (c[who] || 0) + Number(el.dataset.d)));
  },
  "priv-start": () => { S.priv = { started: true, index: 0, handoff: true, done: false, revealed: false }; },
  "priv-go": () => { S.priv.handoff = false; },
  "priv-skip": () => advancePrivate(),
  "priv-next": () => advancePrivate(),
  "priv-restart": () => { S.priv = { started: true, index: 0, handoff: true, done: false, revealed: false }; },
  reveal: () => { S.priv.revealed = true; revealing = true; },
  "fix-everyone": (el) => {
    const it = S.items.find((i) => i.id === el.dataset.id);
    delete S.portions[it.id];
    S.claims[it.id] = Object.fromEntries(S.people.map((p) => [p.id, 1]));
    it.shared = true;
  },
  "fix-give": (el) => {
    const it = S.items.find((i) => i.id === el.dataset.id);
    delete S.portions[it.id];
    S.claims[it.id] = { [el.dataset.pid]: it.qty };
    it.shared = false;
  },
  "fix-shared": (el) => {
    const it = S.items.find((i) => i.id === el.dataset.id);
    const c = S.claims[it.id] || {};
    const ids = Object.keys(c).filter((id) => c[id] > 0);
    if (ids.length === 1) S.claims[it.id] = { [ids[0]]: it.qty };
    else it.shared = true;
  },
  "fix-rest": (el) => { S.items.find((i) => i.id === el.dataset.id).restEven = true; },
  picker: (el) => { S.tip.picker = el.dataset.id; },
  "tip-pct": (el) => { S.tip.mode = "percent"; S.tip.percent = Number(el.dataset.pct); },
  "tip-split": (el) => { S.tip.split = el.dataset.split; },
  cover: (el) => {
    const id = el.dataset.id;
    const on = S.covered.includes(id);
    if (!on && S.covered.length >= S.people.length - 1) { toast("Someone has to pay for something."); return false; }
    S.covered = on ? S.covered.filter((x) => x !== id) : [...S.covered, id];
  },
  paid: (el) => {
    const id = el.dataset.id;
    const on = S.paid.includes(id);
    S.paid = on ? S.paid.filter((x) => x !== id) : [...S.paid, id];
    if (on) wasSettled = false;
    else navigator.vibrate?.(12);
  },
  copy: () => {
    const sp = split();
    const payer = person(S.payer);
    const t = S.tip.mode === "percent" ? `${S.tip.percent}% tip` : `${dollars(sp.tipTotal)} tip`;
    const lines = [
      `${S.merchant || "Dinner"}: ${dollars(sp.grandTotal)} with ${t}`,
      `${payer.name} paid. Owed to ${payer.name}:`,
      ...sp.rows.filter((r) => r.id !== payer.id).map((r) => `  ${person(r.id).name}  ${dollars(r.total)}${S.paid.includes(r.id) ? " (paid)" : ""}`),
      `${payer.name}'s own share: ${dollars(sp.rows.find((r) => r.id === payer.id).total)}`,
    ];
    copyText(lines.join("\n")).then(
      () => toast("Summary copied. Paste it in the group chat."),
      () => toast("Couldn't reach the clipboard. Select the amounts and copy them by hand."),
    );
    return false;
  },
  new: (el) => {
    if (el.dataset.confirm !== "1") {
      el.dataset.confirm = "1";
      const label = el.textContent;
      el.textContent = "Clear this bill?";
      setTimeout(() => { if (el.isConnected) { el.dataset.confirm = ""; el.textContent = label; } }, 3000);
      return false;
    }
    el.dataset.confirm = "";
    el.textContent = "New bill";
    leaveLive();
    S = blank();
    photo = null;
    ocr = null;
    shown.clear();
    tweened.clear();
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  if (fn(el, e) !== false) render();
});

// Field edits commit on change; Enter or Escape finishes the field.
document.addEventListener("keydown", (e) => {
  const el = e.target;
  if ((e.key === "Enter" || e.key === "Escape") && el.matches?.("input[data-field]")) {
    e.preventDefault();
    el.blur();
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  const f = el.dataset?.field;
  if (!f) return;
  const id = el.dataset.id;
  const item = S.items.find((i) => i.id === id);
  const fee = S.fees.find((x) => x.id === id);
  switch (f) {
    case "merchant": S.merchant = el.value.trim(); break;
    case "name": item.name = el.value.trim(); break;
    case "qty": item.qty = Math.max(1, Math.min(99, Number.parseInt(el.value, 10) || 1)); break;
    case "price": item.price = Math.abs(parseMoney(el.value)); break;
    case "tax": S.tax = Math.abs(parseMoney(el.value)); break;
    case "fee-name": fee.name = el.value.trim() || "Fee"; break;
    case "fee-amount": fee.amount = parseMoney(el.value); break;
    case "person-name": {
      const p = person(id);
      p.name = el.value.trim() || p.name;
      break;
    }
    case "tip-percent": {
      const n = Number.parseFloat(el.value);
      if (Number.isFinite(n) && n >= 0 && n <= 100) { S.tip.mode = "percent"; S.tip.percent = Math.round(n * 10) / 10; }
      break;
    }
    case "tip-amount": {
      if (el.value.trim() === "") { S.tip.mode = "percent"; break; }
      S.tip.mode = "amount";
      S.tip.amount = Math.abs(parseMoney(el.value));
      break;
    }
    case "tip-base": S.tip.base = el.checked ? "pretax" : "posttax"; break;
  }
  render();
});

document.addEventListener("submit", (e) => {
  const form = e.target;
  if (form.dataset.form === "join") {
    e.preventDefault();
    beginJoin(form.elements.code.value);
    render();
    return;
  }
  if (form.dataset.form === "join-new") {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) return;
    const p = { id: uid(), name, ink: nextInk(), at: Date.now() };
    S.people.push(p);
    finishJoin(p.id);
    render();
    return;
  }
  if (form.dataset.form !== "add-person") return;
  e.preventDefault();
  const input = form.elements.name;
  const name = input.value.trim();
  if (!name) return;
  if (S.people.length >= INKS.length) { toast(`Chit handles up to ${INKS.length} people for now.`); return; }
  const p = { id: uid(), name, ink: nextInk(), at: Date.now() };
  S.people.push(p);
  if (!S.payer) S.payer = p.id;
  resetPrivate();
  input.value = "";
  render();
  $('[data-key="add-person"]')?.focus();
});

for (const id of ["#file", "#camera"]) {
  $(id).addEventListener("change", (e) => {
    readFile(e.target.files[0]);
    e.target.value = "";
  });
}

// Drop a photo anywhere on the page.
["dragenter", "dragover"].forEach((t) => window.addEventListener(t, (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  e.preventDefault();
  document.body.classList.add("dragging");
}));
window.addEventListener("dragleave", (e) => {
  if (e.relatedTarget == null) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const file = e.dataTransfer?.files?.[0];
  if (file) { S.step = "receipt"; readFile(file); }
});

if (!canVisit(S.step)) S.step = "receipt";
const invite = location.hash.match(/join=([A-Za-z0-9]{4,6})/);
if (invite) {
  history.replaceState(null, "", location.pathname);
  if (cleanCode(invite[1]) !== live?.code) beginJoin(invite[1]);
}
if (live && !room) startRoom({ seed: "resume" });
render();
window.addEventListener("load", () => setTimeout(warmReader, 600));

if ("serviceWorker" in navigator && !["localhost", "127.0.0.1"].includes(location.hostname)) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

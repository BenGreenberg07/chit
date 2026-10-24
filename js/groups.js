// Tables you've sat at before. A group is just the set of names, kept on this
// device beside the bill: no accounts, nothing uploaded. Chit remembers the pen
// each person wrote with, so the same friend gets the same colour next time.

const STORE = "chit.groups.v1";
const MAX_GROUPS = 12;

const clean = (s) => String(s ?? "").trim();
const fold = (s) => clean(s).toLowerCase();

// A group is identified by who's in it, not by when it happened: the same five
// people are the same table whether it's Tuesday's noodles or Friday's pizza.
export const groupKey = (names) => names.map(fold).filter(Boolean).sort().join("\u0000");

// Newest first. Anything that isn't a well-formed group is dropped rather than
// thrown: a half-written store shouldn't take the Table step down with it.
export function readGroups(store = safeStore()) {
  try {
    const raw = store?.getItem(STORE);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(valid).sort((a, b) => b.at - a.at) : [];
  } catch {
    return [];
  }
}

export function writeGroups(list, store = safeStore()) {
  try { store?.setItem(STORE, JSON.stringify(list)); } catch {}
}

function valid(g) {
  return g && typeof g.key === "string" && typeof g.id === "string"
    && Number.isFinite(g.at) && Array.isArray(g.people) && g.people.length >= 2
    && g.people.every((p) => clean(p?.name));
}

// Folding a table into the list: an existing group with the same people moves
// to the front with its names and pens refreshed, so a rename sticks.
export function withGroup(list, people, now = Date.now(), id = String(now)) {
  const members = people.map((p) => ({ name: clean(p.name), ink: p.ink })).filter((p) => p.name);
  if (members.length < 2) return list;
  const key = groupKey(members.map((p) => p.name));
  const prev = list.find((g) => g.key === key);
  // Someone handed in without a pen keeps the one they had last time.
  for (const m of members) {
    if (m.ink) continue;
    const was = prev?.people.find((q) => fold(q.name) === fold(m.name));
    if (was?.ink) m.ink = was.ink;
    else delete m.ink;
  }
  const entry = { id: prev?.id ?? id, key, people: members, at: now };
  return [entry, ...list.filter((g) => g.key !== key)].slice(0, MAX_GROUPS);
}

export function rememberGroup(people, store = safeStore()) {
  const list = withGroup(readGroups(store), people);
  writeGroups(list, store);
  return list;
}

export function forgetGroup(id, store = safeStore()) {
  const list = readGroups(store).filter((g) => g.id !== id);
  writeGroups(list, store);
  return list;
}

// The pen this person wrote with last time, looking at the most recent tables
// first. Returns undefined for someone Chit has never seen.
export function inkForName(name, list) {
  const want = fold(name);
  if (!want) return undefined;
  for (const g of list ?? readGroups()) {
    const hit = g.people.find((p) => fold(p.name) === want);
    if (hit?.ink) return hit.ink;
  }
  return undefined;
}

// Every name Chit knows, newest table first, for the add-a-name suggestions.
export function knownNames(list) {
  const out = [];
  const seen = new Set();
  for (const g of list ?? readGroups()) {
    for (const p of g.people) {
      const k = fold(p.name);
      if (k && !seen.has(k)) { seen.add(k); out.push(clean(p.name)); }
    }
  }
  return out;
}

// "Ben, Mia and Theo" up to three; past that, the first two and a count, so the
// line stays one line on a phone.
export function groupLabel(g) {
  const names = g.people.map((p) => clean(p.name));
  if (names.length <= 3) return names.length < 3 ? names.join(" and ") : `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

// How long ago, in the words someone would actually use at a table.
export function agoText(then, now = Date.now()) {
  const days = Math.floor((now - then) / 86400000);
  if (!Number.isFinite(days) || days < 0) return "just now";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return days < 365 ? `${Math.round(days / 30)} months ago` : "over a year ago";
}

function safeStore() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// Who actually sits down when a remembered table is seated. The same ten
// people eat together all weekend without all ten being at every meal, so the
// members are ticked or unticked by index (two friends can share a name), and
// anyone already at the table keeps their seat rather than arriving twice.
// `short` is how many were ticked but found no seat.
export function seatingPlan(seated, members, { skip, max = 10 } = {}) {
  const off = skip ?? new Set();
  const here = new Set(seated.map((p) => fold(p.name)));
  const wanted = members.filter((m, i) => !off.has(i) && clean(m.name) && !here.has(fold(m.name)));
  const room = Math.max(0, max - seated.length);
  return { seat: wanted.slice(0, room), short: Math.max(0, wanted.length - room) };
}

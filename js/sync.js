// Live bills shared between phones through ntfy.sh, a free pub/sub relay that
// needs no account. Every phone holds the bill as a map of small keyed facts
// ("claim of item X by person Y is 1"). Changes go out as ops; the newest write
// per key wins, so two people claiming different things never collide.
//
// ntfy only caches messages while someone is subscribed, so a joiner can't
// count on replay. Instead it says hello, and phones already in the bill answer
// with a snapshot of everything they know.

const RELAY = "https://ntfy.sh/";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_PLAIN = 3500;

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function cleanCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0").slice(0, 5);
}

// Newest write wins. Exact ties (same time, same phone) fall back to comparing
// the values themselves, so every phone picks the same winner in any order.
const newer = (a, b) => {
  if (!b) return true;
  if (a.ts !== b.ts) return a.ts > b.ts;
  if (a.by !== b.by) return a.by > b.by;
  return JSON.stringify(a.v ?? null) > JSON.stringify(b.v ?? null);
};

async function pack(obj) {
  const json = JSON.stringify(obj);
  if (json.length <= MAX_PLAIN || typeof CompressionStream === "undefined") return json;
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return "z:" + btoa(bin);
}

async function unpack(text) {
  if (!text.startsWith("z:")) return JSON.parse(text);
  const buf = Uint8Array.from(atob(text.slice(2)), (c) => c.charCodeAt(0));
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

export class Room {
  constructor({ code, clientId, onChange, onStatus }) {
    this.code = code;
    this.topic = "chit-v1-" + code.toLowerCase();
    this.clientId = clientId;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.data = {};
    this.meta = {};
    this.peers = new Map();
    this.pending = new Map();
    this.lastId = "all";
    this.status = "connecting";
    this.closed = false;
    this.ready = false;
    this.maxTs = 0;
  }

  // Seed with what this phone already has. A phone resuming after a reload
  // seeds with an ancient timestamp so anything newer from friends wins.
  seed(map, ts = Date.now()) {
    this.ready = true;
    for (const [k, v] of Object.entries(map)) {
      this.data[k] = v;
      this.meta[k] = { ts, by: this.clientId, v };
    }
  }

  connect() {
    this.closed = false;
    this.es?.close();
    this.setStatus("connecting");
    const es = new EventSource(`${RELAY}${this.topic}/sse?since=${this.lastId}`);
    this.es = es;
    es.addEventListener("open", () => {
      this.setStatus("live");
      this.post({ t: "hello", by: this.clientId });
      if (Object.keys(this.data).length) this.sendSnapshot();
      this.flush();
    });
    es.addEventListener("message", (e) => this.receive(e));
    es.addEventListener("error", () => {
      if (this.closed) return;
      this.setStatus("reconnecting");
      es.close();
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), 2500);
    });
  }

  close() {
    this.closed = true;
    this.es?.close();
    clearTimeout(this.retry);
    clearTimeout(this.flushTimer);
    clearTimeout(this.snapTimer);
  }

  setStatus(s) {
    this.status = s;
    this.onStatus?.(s);
  }

  async receive(e) {
    let msg;
    try {
      const env = JSON.parse(e.data);
      if (env.id) this.lastId = env.id;
      if (env.event !== "message") return;
      msg = await unpack(env.message);
    } catch {
      return;
    }
    if (!msg || msg.by === this.clientId) return;
    this.peers.set(msg.by, Date.now());

    if (msg.t === "hello") {
      // Answer joiners, but let only one phone do it: wait a random beat and
      // stand down if someone else's snapshot shows up first.
      if (!Object.keys(this.data).length) return;
      clearTimeout(this.snapTimer);
      this.snapTimer = setTimeout(() => this.sendSnapshot(), 300 + Math.random() * 1200);
      return;
    }
    if (msg.t === "snap") clearTimeout(this.snapTimer);
    if (msg.t === "ops" || msg.t === "snap") {
      let changed = false;
      for (const [k, v, ts, by] of msg.ops) {
        this.maxTs = Math.max(this.maxTs, ts);
        if (newer({ ts, by, v }, this.meta[k])) {
          this.meta[k] = { ts, by, v };
          if (v === null) delete this.data[k];
          else this.data[k] = v;
          changed = true;
        }
      }
      if (changed || !this.ready) {
        this.ready = true;
        this.onChange?.(this.data, msg.by);
      }
    }
  }

  // Record local changes and send them, batched.
  set(changes) {
    // Never stamp a change older than something already seen: a phone whose
    // clock runs behind would otherwise lose its own newer edits.
    const ts = (this.maxTs = Math.max(Date.now(), this.maxTs + 1));
    for (const [k, v] of Object.entries(changes)) {
      this.meta[k] = { ts, by: this.clientId, v };
      if (v === null) delete this.data[k];
      else this.data[k] = v;
      this.pending.set(k, [k, v, ts, this.clientId]);
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 250);
  }

  async flush() {
    if (!this.pending.size || this.status !== "live") return;
    const ops = [...this.pending.values()];
    this.pending.clear();
    const ok = await this.post({ t: "ops", by: this.clientId, ops });
    if (!ok) {
      // Put them back unless something newer was written meanwhile.
      for (const op of ops) if (!this.pending.has(op[0])) this.pending.set(op[0], op);
      clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), 5000);
    }
  }

  sendSnapshot() {
    const ops = Object.keys(this.meta).map((k) => [k, k in this.data ? this.data[k] : null, this.meta[k].ts, this.meta[k].by]);
    return this.post({ t: "snap", by: this.clientId, ops });
  }

  async post(msg) {
    try {
      const res = await fetch(RELAY + this.topic, { method: "POST", body: await pack(msg) });
      return res.ok;
    } catch {
      return false;
    }
  }

  peerCount() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    return [...this.peers.values()].filter((t) => t > cutoff).length;
  }
}

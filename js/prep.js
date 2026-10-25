// Evens out the lighting on a receipt photo before OCR. Phone shots of
// receipts usually have a shadow or glare across part of the slip, and the
// reader's single global threshold then wipes out whole columns of prices.
// Dividing each pixel by the local paper brightness makes shaded paper and
// lit paper both come out white, with the ink dark on top.
//
// Works on raw RGBA pixels (no canvas filters, which Safari ignores).
//
// `strong` stretches harder where the ink itself is faint (glare, a washed
// out print). It rescues those photos but roughens clean ones, so it's only
// used for a second look when the first read doesn't add up.

const CELL = 16; // block size for estimating paper brightness

export function flattenLight(rgba, width, height, { strong = false } = {}) {
  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }

  // Paper brightness per block: a high percentile, so ink doesn't drag it down.
  const gw = Math.ceil(width / CELL);
  const gh = Math.ceil(height / CELL);
  const grid = new Float32Array(gw * gh);
  const ink = new Float32Array(gw * gh);
  const hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      let count = 0;
      const y1 = Math.min(height, (gy + 1) * CELL);
      const x1 = Math.min(width, (gx + 1) * CELL);
      for (let y = gy * CELL; y < y1; y++) {
        for (let x = gx * CELL; x < x1; x++) {
          hist[gray[y * width + x] | 0]++;
          count++;
        }
      }
      let need = count * 0.1;
      let v = 255;
      while (v > 0 && need > 0) need -= hist[v--];
      grid[gy * gw + gx] = v + 1;
      need = count * 0.03;
      let lo = 0;
      while (lo < 255 && need > 0) need -= hist[lo++];
      ink[gy * gw + gx] = Math.max(0, lo - 1);
    }
  }

  // Smooth the block grid so block edges don't print as faint lines.
  const smooth = blur(blur(grid, gw, gh, 2), gw, gh, 2);

  // How dark the ink gets nearby, relative to its paper. Glare and fading
  // lift the ink toward the paper, so stretch harder there.
  const faint = new Float32Array(gw * gh);
  const R = 3;
  for (let gy = 0; strong && gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let m = 1;
      for (let y = Math.max(0, gy - R); y <= Math.min(gh - 1, gy + R); y++) {
        for (let x = Math.max(0, gx - R); x <= Math.min(gw - 1, gx + R); x++) {
          m = Math.min(m, ink[y * gw + x] / Math.max(24, grid[y * gw + x]));
        }
      }
      faint[gy * gw + gx] = m;
    }
  }
  const lift = blur(faint, gw, gh, 2);

  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / CELL - 0.5));
    const y0 = fy | 0;
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / CELL - 0.5));
      const x0 = fx | 0;
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const top = smooth[y0 * gw + x0] * (1 - tx) + smooth[y0 * gw + x1] * tx;
      const bot = smooth[y1 * gw + x0] * (1 - tx) + smooth[y1 * gw + x1] * tx;
      const paper = Math.max(24, top * (1 - ty) + bot * ty);
      const f = lift[y0 * gw + x0] * (1 - tx) * (1 - ty) + lift[y0 * gw + x1] * tx * (1 - ty)
        + lift[y1 * gw + x0] * (1 - tx) * ty + lift[y1 * gw + x1] * tx * ty;
      // ratio 1 = paper, ink sits below; stretch the band in between, from
      // just above the local ink level.
      const lo = strong ? Math.min(0.72, Math.max(0.5, f + 0.15)) : 0.5;
      const r = (gray[y * width + x] / paper - lo) / (0.95 - lo);
      const v = r <= 0 ? 0 : r >= 1 ? 255 : Math.round(r * 255);
      const p = (y * width + x) * 4;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    }
  }
  return out;
}

function blur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += src[y * w + k]; c++; }
      tmp[y * w + x] = s / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; c++; }
      dst[y * w + x] = s / c;
    }
  }
  return dst;
}

// ---------- finding the slip ----------
// Receipts get photographed on granite, wood grain, patterned tablecloths.
// The reader turns that texture into hundreds of fake words that land on the
// same lines as the real ones. So before reading: find the paper, crop to it,
// and blank out whatever else is left in the frame.
//
// Paper is the large, bright, mostly colorless region (warm restaurant light
// tints it, so the color limit is loose; brightness does most of the work). Per block, take the median
// brightness (text is sparse, so it barely moves the median) and saturation;
// split bright from dark with Otsu's threshold; keep the biggest connected
// bright, gray region. Returns { x, y, w, h, keep } or null when there's no
// clear slip (a photo that's all receipt needs no cropping).

const PAPER_CELL = 24;

export function findPaper(rgba, width, height) {
  const bw = Math.ceil(width / PAPER_CELL);
  const bh = Math.ceil(height / PAPER_CELL);
  const bright = new Float32Array(bw * bh);
  const sat = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      let s = 0;
      for (let y = by * PAPER_CELL; y < Math.min(height, (by + 1) * PAPER_CELL); y += 2) {
        for (let x = bx * PAPER_CELL; x < Math.min(width, (bx + 1) * PAPER_CELL); x += 2) {
          const p = (y * width + x) * 4;
          const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
          const mx = Math.max(r, g, b);
          hist[(0.299 * r + 0.587 * g + 0.114 * b) | 0]++;
          s += mx ? (mx - Math.min(r, g, b)) / mx : 0;
          n++;
        }
      }
      let need = n / 2;
      let v = 0;
      while (v < 255 && need > 0) need -= hist[v++];
      bright[by * bw + bx] = v;
      sat[by * bw + bx] = s / n;
    }
  }

  const cut = otsu(bright);
  const paper = new Uint8Array(bw * bh);
  for (let i = 0; i < paper.length; i++) paper[i] = bright[i] > cut && sat[i] < 0.45 ? 1 : 0;

  // Shadow falls across slips (a hand, a phone, a glass). Shaded paper is
  // darker but still colorless, and it darkens gradually, while the slip's
  // edge against the table is a sudden jump. Grow the paper into neighbors
  // like that.
  const queue = [];
  for (let i = 0; i < paper.length; i++) if (paper[i]) queue.push(i);
  while (queue.length) {
    const j = queue.pop();
    const x = j % bw;
    const y = (j / bw) | 0;
    for (const k of [x > 0 ? j - 1 : -1, x < bw - 1 ? j + 1 : -1, y > 0 ? j - bw : -1, y < bh - 1 ? j + bw : -1]) {
      if (k < 0 || paper[k]) continue;
      if (sat[k] < 0.22 && bright[k] > 55 && Math.abs(bright[k] - bright[j]) < 22) {
        paper[k] = 1;
        queue.push(k);
      }
    }
  }

  // Biggest connected patch of paper.
  const label = new Int32Array(bw * bh).fill(-1);
  let best = -1;
  let bestSize = 0;
  const stack = [];
  for (let i = 0; i < paper.length; i++) {
    if (!paper[i] || label[i] >= 0) continue;
    let size = 0;
    stack.push(i);
    label[i] = i;
    while (stack.length) {
      const j = stack.pop();
      size++;
      const x = j % bw;
      const y = (j / bw) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < bw - 1 ? j + 1 : -1, y > 0 ? j - bw : -1, y < bh - 1 ? j + bw : -1]) {
        if (k >= 0 && paper[k] && label[k] < 0) { label[k] = i; stack.push(k); }
      }
    }
    if (size > bestSize) { bestSize = size; best = i; }
  }
  const share = bestSize / (bw * bh);
  if (best < 0 || share < 0.06 || share > 0.85) return null;

  // Fill each row of the slip from its left edge to its right edge, so dense
  // text and the logo count as paper too, then grow it a block for the edges.
  const keep = new Uint8Array(bw * bh);
  let x0 = bw, x1 = -1, y0 = bh, y1 = -1;
  for (let by = 0; by < bh; by++) {
    let lo = -1, hi = -1;
    for (let bx = 0; bx < bw; bx++) {
      if (label[by * bw + bx] === best) { if (lo < 0) lo = bx; hi = bx; }
    }
    if (lo < 0) continue;
    for (let bx = lo; bx <= hi; bx++) keep[by * bw + bx] = 1;
    x0 = Math.min(x0, lo); x1 = Math.max(x1, hi); y0 = Math.min(y0, by); y1 = Math.max(y1, by);
  }
  const grown = new Uint8Array(keep);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (keep[by * bw + bx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy, xx = bx + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw && keep[yy * bw + xx]) grown[by * bw + bx] = 1;
        }
      }
    }
  }
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(bw - 1, x1 + 1); y1 = Math.min(bh - 1, y1 + 1);
  return {
    x: x0 * PAPER_CELL,
    y: y0 * PAPER_CELL,
    w: Math.min(width, (x1 + 1) * PAPER_CELL) - x0 * PAPER_CELL,
    h: Math.min(height, (y1 + 1) * PAPER_CELL) - y0 * PAPER_CELL,
    keep: (x, y) => grown[((y / PAPER_CELL) | 0) * bw + ((x / PAPER_CELL) | 0)] === 1,
  };
}

function otsu(values) {
  const hist = new Uint32Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, cut = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; cut = t; }
  }
  return cut;
}

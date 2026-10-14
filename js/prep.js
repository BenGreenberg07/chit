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

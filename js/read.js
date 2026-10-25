// Reads a receipt photo into a parsed receipt: finds the slip, evens out the
// light, and runs the reader (Tesseract) up to three ways, keeping whichever
// read checks out against the receipt's own totals.
import { parseReceipt, textFromWords, linesFromWords, mergeReads, hasScraps, readScore, addsUp } from "./parse.js";
import { flattenLight, findPaper } from "./prep.js";

export async function readPhoto(src, worker, { onRetry } = {}) {
  const prepared = await preparePhoto(src);
  let r = await readOnce(worker, prepared());
  // If the read doesn't add up, look again: word by word (prices printed off
  // their lines), then with a harder contrast stretch (glare, fading), then
  // the whole photo uncropped, in case finding the slip cut some of it off.
  const tries = [
    () => readOnce(worker, prepared(), "words"),
    () => readOnce(worker, prepared({ strong: true })),
    async () => readOnce(worker, (await preparePhoto(src, { crop: false }))()),
  ];
  const reads = [r];
  let next = 0;
  for (; next < tries.length && !addsUp(r); next++) {
    onRetry?.();
    const again = await tries[next]();
    reads.push(again);
    if (readScore(again) > readScore(r)) r = again;
  }
  // The totals check out but some dish names came out broken: one more read
  // with the harder contrast usually spells them right, for the merge below.
  if (next < 2 && hasScraps(r)) {
    onRetry?.();
    reads.push(await tries[1]());
  }
  // Each way of reading has blind spots; let the others fill in quantities
  // and cleaner names on the read that checks out.
  return mergeReads(r, reads.filter((x) => x !== r));
}

export async function preparePhoto(src, { crop = true } = {}) {
  // img.decode() can stall when the browser deprioritizes the tab; the plain
  // load event always fires.
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  // Find the slip on a small copy, so a granite counter or patterned
  // tablecloth around it never reaches the reader.
  const k = Math.min(1, 800 / Math.max(W, H));
  const small = document.createElement("canvas");
  small.width = Math.round(W * k);
  small.height = Math.round(H * k);
  const sg = small.getContext("2d", { willReadFrequently: true });
  sg.drawImage(img, 0, 0, small.width, small.height);
  const slip = crop ? findPaper(sg.getImageData(0, 0, small.width, small.height).data, small.width, small.height) : null;
  const [sx, sy, sw, sh] = slip ? [slip.x / k, slip.y / k, slip.w / k, slip.h / k] : [0, 0, W, H];
  // Cut the slip from the full photo at ~1400px wide: sharp enough for small
  // print, small enough to read quickly.
  const scale = Math.min(3, 1400 / sw, 4500 / sh);
  const c = document.createElement("canvas");
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const raw = g.getImageData(0, 0, c.width, c.height).data;
  if (slip) {
    // Paint what isn't slip white (the counter showing past a tilted edge).
    for (let y = 0; y < c.height; y++) {
      const yy = (sy + y / scale) * k;
      for (let x = 0; x < c.width; x++) {
        if (slip.keep((sx + x / scale) * k, yy)) continue;
        const p = (y * c.width + x) * 4;
        raw[p] = raw[p + 1] = raw[p + 2] = 255;
      }
    }
  }
  // Even out shadows and glare so faded or shaded prices still read.
  return (opts) => {
    const px = g.getImageData(0, 0, c.width, c.height);
    px.data.set(flattenLight(raw, c.width, c.height, opts));
    g.putImageData(px, 0, 0);
    return c;
  };
}

// One pass of the reader. "lines" trusts the reader's own line grouping;
// "words" reads loose words and pairs prices with labels by position, which
// copes with printers that set prices half a line off their labels.
export async function readOnce(worker, canvas, mode = "lines") {
  if (mode === "words") {
    await worker.setParameters({ tessedit_pageseg_mode: "11" });
    try {
      const { data } = await worker.recognize(canvas);
      return parseReceipt(linesFromWords(data.words || []));
    } finally {
      await worker.setParameters({ tessedit_pageseg_mode: "3" });
    }
  }
  const { data } = await worker.recognize(canvas);
  const lines = data.lines?.length
    ? data.lines
    : (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  return parseReceipt(lines.length ? textFromWords(lines) : data.text);
}

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * Original, deterministic PDF specimens for PaperPilot's structural-map tests.
 *
 * These are test data, not scientific papers. No downloaded/private content,
 * PDF writer dependency, font binary, timestamp, random ID, or network request
 * is involved. This module is not included in the public Pages artifact.
 */

function pdfString(value) {
  return `(${String(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")})`;
}

function textLine(text, x, y, size = 11, bold = false) {
  return `BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x} ${y} Tm ${pdfString(text)} Tj ET`;
}

function streamObject(dictionary, bytes) {
  const data = typeof bytes === "string" ? Buffer.from(bytes, "ascii") : bytes;
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, "ascii"),
    data,
    Buffer.from("\nendstream", "ascii"),
  ]);
}

function syntheticScanPixels(width = 96, height = 128) {
  const pixels = Buffer.alloc(width * height, 247);
  const fill = (left, top, right, bottom, shade) => {
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) pixels[y * width + x] = shade;
    }
  };
  fill(7, 8, 89, 10, 48);
  fill(7, 118, 89, 120, 48);
  fill(7, 8, 9, 120, 48);
  fill(87, 8, 89, 120, 48);
  for (let line = 0; line < 7; line += 1) fill(16, 20 + line * 6, 79 - (line % 3) * 7, 22 + line * 6, 85);
  fill(18, 76, 20, 108, 52);
  fill(18, 106, 78, 108, 52);
  fill(27, 92, 35, 106, 108);
  fill(43, 85, 51, 106, 78);
  fill(59, 77, 67, 106, 42);
  return { width, height, pixels };
}

function constructPdf({ title, pages, outline = [], includeScan = false }) {
  const objects = [null];
  const reserve = () => { objects.push(null); return objects.length - 1; };
  const set = (id, value) => { objects[id] = typeof value === "string" ? Buffer.from(value, "ascii") : value; };
  const catalogId = reserve();
  const pagesId = reserve();
  const fontId = reserve();
  const boldFontId = reserve();
  const infoId = reserve();
  const pageIds = pages.map(() => reserve());
  const contentIds = pages.map(() => reserve());
  let scanId = null;
  if (includeScan) {
    scanId = reserve();
    const scan = syntheticScanPixels();
    set(scanId, streamObject(`/Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(scan.pixels)));
  }

  set(fontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  set(boldFontId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  set(infoId, `<< /Title ${pdfString(title)} /Author (PaperPilot test suite) /Subject (Original synthetic fixture; not a scientific paper) /Producer (PaperPilot deterministic test fixture) >>`);
  set(pagesId, `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`);

  for (const [index, page] of pages.entries()) {
    const cropBox = page.cropBox || [0, 0, 612, 792];
    const xObjects = scanId ? `/XObject << /Scan ${scanId} 0 R >>` : "";
    set(pageIds[index], `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /CropBox [${cropBox.join(" ")}] /Rotate ${page.rotation || 0} /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> ${xObjects} >> /Contents ${contentIds[index]} 0 R >>`);
    set(contentIds[index], streamObject("", page.content));
  }

  let outlineRootId = null;
  const namedDestinations = [];
  if (outline.length) {
    outlineRootId = reserve();
    const attachSiblings = (entries, parentId) => {
      const ids = entries.map(() => reserve());
      let descendants = entries.length;
      for (const [index, entry] of entries.entries()) {
        const children = entry.items?.length ? attachSiblings(entry.items, ids[index]) : null;
        descendants += children?.descendants || 0;
        const destination = `[${pageIds[entry.pageIndex]} 0 R /Fit]`;
        const name = `fixture-destination-${ids[index]}`;
        const dest = entry.named ? pdfString(name) : destination;
        if (entry.named) namedDestinations.push(`${pdfString(name)} ${destination}`);
        const previous = index > 0 ? `/Prev ${ids[index - 1]} 0 R` : "";
        const next = index + 1 < entries.length ? `/Next ${ids[index + 1]} 0 R` : "";
        const childRefs = children ? `/First ${children.first} 0 R /Last ${children.last} 0 R /Count ${children.descendants}` : "";
        set(ids[index], `<< /Title ${pdfString(entry.title)} /Parent ${parentId} 0 R ${previous} ${next} ${childRefs} /Dest ${dest} >>`);
      }
      return { first: ids[0], last: ids.at(-1), descendants };
    };
    const tree = attachSiblings(outline, outlineRootId);
    set(outlineRootId, `<< /Type /Outlines /First ${tree.first} 0 R /Last ${tree.last} 0 R /Count ${tree.descendants} >>`);
  }
  const outlineRef = outlineRootId ? `/Outlines ${outlineRootId} 0 R` : "";
  const names = namedDestinations.length ? `/Names << /Dests << /Names [${namedDestinations.sort().join(" ")}] >> >>` : "";
  set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R ${outlineRef} ${names} >>`);

  const chunks = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets = [0];
  let byteLength = chunks[0].length;
  for (let id = 1; id < objects.length; id += 1) {
    if (!objects[id]) throw new Error(`Synthetic PDF object ${id} was not assigned.`);
    offsets.push(byteLength);
    const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`, "ascii"), objects[id], Buffer.from("\nendobj\n", "ascii")]);
    chunks.push(chunk);
    byteLength += chunk.length;
  }
  const xrefOffset = byteLength;
  const xref = offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  chunks.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${xref}trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, "ascii"));
  return new Uint8Array(Buffer.concat(chunks));
}

function ordinaryPage(pageIndex, heading, { columns = false, figure = false, rotation = 0, cropBox } = {}) {
  const lines = [
    textLine("PaperPilot original synthetic fixture", 54, cropBox ? 748 : 766, 9),
    ...(heading ? [textLine(heading, 54, 728, 16, true)] : []),
  ];
  const bodyY = heading ? 698 : 718;
  if (columns) {
    for (const [column, x] of [54, 326].entries()) {
      for (let line = 0; line < 8; line += 1) {
        lines.push(textLine(`Column ${column + 1} contains sample ${line + 1} for layout.`, x, bodyY - line * 17, 9));
      }
    }
  } else {
    lines.push(textLine("This page contains original sample prose for structural coverage testing.", 54, bodyY, 11));
    lines.push(textLine("The sentences are fixture data and do not state scientific findings.", 54, bodyY - 20, 11));
    lines.push(textLine("Page position is tested independently of semantic importance or truth.", 54, bodyY - 40, 11));
  }
  if (figure) {
    lines.push("q 0.93 0.96 0.98 rg 72 258 468 238 re f 0.18 0.29 0.38 RG 1.5 w 100 286 m 100 468 l 514 468 m 100 468 l S");
    lines.push("0.22 0.49 0.61 rg 145 286 54 64 re f 244 286 54 103 re f 343 286 54 142 re f 442 286 54 166 re f Q");
    lines.push(textLine(`Figure ${Math.floor(pageIndex / 2) + 1}. Original vector bars for figure-layout testing.`, 72, 240, 10));
  }
  lines.push(textLine(String(pageIndex + 1), 300, 35, 9));
  return { content: lines.join("\n"), rotation, ...(cropBox ? { cropBox } : {}) };
}

const FIXTURE_FACTS = Object.freeze({
  "outline-rich": {
    filename: "paperpilot-synthetic-outline-rich.pdf",
    title: "Original outline-rich structural fixture",
    pageCount: 8,
    purpose: "Named and explicit destinations, nested outline entries, rotation and CropBox geometry.",
  },
  "outline-free": {
    filename: "paperpilot-synthetic-outline-free.pdf",
    title: "Original outline-free structural fixture",
    pageCount: 23,
    purpose: "No outline or unique headings; deterministic fallback groups of 10, 10, and 3 pages.",
  },
  "multicolumn-figures": {
    filename: "paperpilot-synthetic-multicolumn-figures.pdf",
    title: "Original multi-column and figure-rich fixture",
    pageCount: 6,
    purpose: "Real two-column text items, conservative section headings, and original vector figures.",
  },
  "limited-text": {
    filename: "paperpilot-synthetic-limited-text.pdf",
    title: "Original limited-text structural fixture",
    pageCount: 4,
    purpose: "One readable text page, one blank page, one image-only scan-like page, and one vector-only page.",
  },
});

export const SYNTHETIC_PDF_FIXTURE_NAMES = Object.freeze(Object.keys(FIXTURE_FACTS));

export function createSyntheticPdfFixture(name) {
  const facts = FIXTURE_FACTS[name];
  if (!facts) throw new TypeError(`Unknown synthetic PDF fixture: ${name}`);
  let pages;
  let outline = [];
  if (name === "outline-rich") {
    const headings = ["Abstract", "1 Introduction", "2 Methods", "2.1 Analysis", "2.2 Validation", "3 Findings", "4 Limitations", "References"];
    pages = headings.map((heading, index) => ordinaryPage(index, heading, {
      rotation: ({ 2: 90, 3: 180, 5: 270 })[index] || 0,
      ...(index === 2 ? { cropBox: [20, 30, 592, 762] } : {}),
    }));
    outline = [
      { title: "Abstract", pageIndex: 0, named: true },
      { title: "Methods", pageIndex: 2, items: [
        { title: "Acquisition", pageIndex: 2, named: true },
        { title: "Analysis", pageIndex: 3 },
      ] },
      { title: "Findings", pageIndex: 5, named: true },
    ];
  } else if (name === "outline-free") {
    pages = Array.from({ length: facts.pageCount }, (_, index) => ordinaryPage(index, null));
  } else if (name === "multicolumn-figures") {
    const headings = { 0: "1 Introduction", 2: "2 Measurements", 4: "RESULTS" };
    pages = Array.from({ length: facts.pageCount }, (_, index) => ordinaryPage(index, headings[index], {
      columns: true,
      figure: index % 2 === 1,
    }));
  } else {
    pages = [
      { content: [
        textLine("Limited-text fixture", 54, 728, 20, true),
        textLine("This original test document contains deliberately limited pages.", 54, 690, 11),
        textLine("Page 2 is blank. Page 3 is a scan-like image. Page 4 is a vector figure.", 54, 670, 11),
        textLine("Only this page has embedded text; the other pages must remain limited.", 54, 650, 11),
        textLine("No scientific claims or copyrighted paper content are included.", 54, 630, 11),
      ].join("\n") },
      { content: "" },
      { content: "q 384 0 0 512 114 140 cm /Scan Do Q" },
      { content: "q 0.92 0.95 0.98 rg 72 140 468 500 re f 0.20 0.41 0.55 rg 120 190 60 140 re f 240 190 60 230 re f 360 190 60 320 re f Q" },
    ];
  }
  const bytes = constructPdf({ title: facts.title, pages, outline, includeScan: name === "limited-text" });
  return {
    name,
    ...facts,
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

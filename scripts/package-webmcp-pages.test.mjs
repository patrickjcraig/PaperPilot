import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { packageWebmcpPages } from "./package-webmcp-pages.mjs";

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? collectFiles(absolute) : [absolute];
  }));
  return nested.flat();
}

test("packages the graph-first upload demo without paper bytes", async () => {
  const packaged = await packageWebmcpPages();
  const files = await collectFiles(packaged.outputRoot);
  const relativeFiles = files.map((file) => path.relative(packaged.outputRoot, file).replaceAll("\\", "/"));

  assert.ok(relativeFiles.includes("webmcp/index.html"));
  assert.ok(relativeFiles.includes("webmcp/app.mjs"));
  assert.ok(relativeFiles.includes("webmcp/browser-snapshot.mjs"));
  assert.ok(relativeFiles.includes("vendor/pdfjs/pdf.worker.min.mjs"));
  assert.ok(relativeFiles.includes("vendor/graphology/graphology.umd.min.js"));
  assert.equal(relativeFiles.some((file) => file.toLowerCase().endsWith(".pdf")), false);

  const indexHtml = await readFile(path.join(packaged.demoRoot, "index.html"), "utf8");
  assert.match(indexHtml, /id="paper-file-input"/u);
  assert.match(indexHtml, /id="load-attention-demo"/u);
  assert.match(indexHtml, /id="save-workspace"/u);
  assert.match(indexHtml, /id="save-explanation"/u);
  assert.match(indexHtml, /connect-src[^;]*https:\/\/arxiv\.org/u);
  assert.doesNotMatch(indexHtml, /(?:id|class)="[^"]*transcript/u);
  assert.doesNotMatch(indexHtml, /(?:src|href)=["']\/vendor\//u);
  assert.equal((await stat(path.join(packaged.outputRoot, ".nojekyll"))).isFile(), true);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

async function artifactManifest(root) {
  const files = await collectFiles(root);
  const records = await Promise.all(files.map(async (file) => {
    const bytes = await readFile(file);
    return {
      path: path.relative(root, file).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
  return records.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

async function assertArtifactContainsNoSensitiveMaterial(manifest, outputRoot) {
  const forbiddenPath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:key|pem|p12|pfx|pdf|map))$/iu;
  const forbiddenContent = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bsb_secret_[A-Za-z0-9._-]{20,}\b/u,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /\b(?:DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY)\s*=\s*["']?[^\s"']{8,}/u,
  ];

  for (const record of manifest) {
    assert.doesNotMatch(record.path, forbiddenPath, `Forbidden generated artifact: ${record.path}`);
    const extension = path.extname(record.path).toLowerCase();
    if (![".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt", ".xml"].includes(extension)) continue;
    const source = await readFile(path.join(outputRoot, ...record.path.split("/")), "utf8");
    for (const pattern of forbiddenContent) {
      assert.doesNotMatch(source, pattern, `Credential-shaped content found in ${record.path}`);
    }
  }
}

test("packages a byte-reproducible public demo without source maps, secrets, or paper bytes", async () => {
  const firstBuild = await packageWebmcpPages();
  const firstManifest = await artifactManifest(firstBuild.outputRoot);
  const packaged = await packageWebmcpPages();
  const secondManifest = await artifactManifest(packaged.outputRoot);
  assert.deepEqual(secondManifest, firstManifest, "Two clean Pages builds must emit byte-identical manifests.");
  await assertArtifactContainsNoSensitiveMaterial(secondManifest, packaged.outputRoot);

  const files = await collectFiles(packaged.outputRoot);
  const relativeFiles = files.map((file) => path.relative(packaged.outputRoot, file).replaceAll("\\", "/"));

  assert.ok(relativeFiles.includes("webmcp/index.html"));
  assert.ok(relativeFiles.includes("webmcp/app.mjs"));
  assert.ok(relativeFiles.includes("webmcp/accessibility-projection.mjs"));
  assert.ok(relativeFiles.includes("webmcp/activity-ledger.mjs"));
  assert.ok(relativeFiles.includes("webmcp/browser-snapshot.mjs"));
  assert.ok(relativeFiles.includes("webmcp/mentor-review.mjs"));
  assert.ok(relativeFiles.includes("webmcp/spatial-anchor.mjs"));
  assert.ok(relativeFiles.includes("webmcp/webmcp-observer.mjs"));
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

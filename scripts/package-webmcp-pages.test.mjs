import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  createReleaseFingerprint,
  packageWebmcpPages,
  versionDemoAssetReferences,
} from "./package-webmcp-pages.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function authoredSourceManifest() {
  const sourceRoot = path.join(repositoryRoot, "spikes", "webmcp-contract");
  const files = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:mjs|html|css)$/u.test(entry.name) && !entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(sourceRoot, entry.name));
  return Promise.all(files.sort().map(async (file) => ({
    file: path.basename(file),
    sha256: createHash("sha256").update(await readFile(file)).digest("hex"),
  })));
}

function moduleSpecifiers(source, filename) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const references = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.ok(node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]),
        `Dynamic imports must expose a literal packaged URL in ${filename}.`);
      references.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return references;
}

async function assertReleaseReferences(packaged, relativeFiles) {
  const entryUrl = new URL("https://example.test/PaperPilot/webmcp/index.html");
  const assertReleaseUrl = (reference, baseUrl, context) => {
    assert.match(reference, /^\.\.?\//u, `${context} must remain repository-relative.`);
    const resolved = new URL(reference, baseUrl);
    assert.equal(resolved.origin, entryUrl.origin, `${context} must remain on the Pages origin.`);
    assert.ok(resolved.pathname.startsWith("/PaperPilot/"), `${context} escaped the repository path.`);
    assert.equal(resolved.searchParams.get("v"), packaged.fingerprint, `${context} has a stale release key.`);
    assert.deepEqual(resolved.searchParams.getAll("v"), [packaged.fingerprint], `${context} repeats its release key.`);
    const artifactPath = resolved.pathname.slice("/PaperPilot/".length);
    assert.ok(relativeFiles.includes(artifactPath), `${context} is absent from the Pages artifact: ${artifactPath}`);
    return artifactPath;
  };

  const indexHtml = await readFile(path.join(packaged.demoRoot, "index.html"), "utf8");
  const entryReferences = [...indexHtml.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/gu)]
    .map((match) => match[1]);
  const entryPaths = entryReferences.map((reference) => assertReleaseUrl(reference, entryUrl, "HTML entry asset"));
  assert.ok(entryPaths.includes("webmcp/app.mjs"));
  assert.ok(entryPaths.includes("webmcp/spike.css"));
  assert.ok(entryPaths.includes("vendor/pdfjs/pdf_viewer.css"));

  let ownedImports = 0;
  for (const file of relativeFiles.filter((value) => value.startsWith("webmcp/") && value.endsWith(".mjs"))) {
    const source = await readFile(path.join(packaged.outputRoot, ...file.split("/")), "utf8");
    for (const reference of moduleSpecifiers(source, file)) {
      const target = assertReleaseUrl(reference, new URL(`../${file}`, entryUrl), `${file} module import`);
      if (target.startsWith("webmcp/")) ownedImports += 1;
    }
    if (file === "webmcp/pdf-viewer.mjs") {
      const workerReference = /worker:\s*new URL\(["']([^"']+)["']/u.exec(source)?.[1];
      assert.ok(workerReference, "The PDF worker must retain a static, versioned packaged URL.");
      assert.equal(assertReleaseUrl(workerReference, entryUrl, "PDF worker"), "vendor/pdfjs/pdf.worker.min.mjs");
      for (const directory of ["standard_fonts", "cmaps", "wasm"]) {
        assert.ok(source.includes(`"../vendor/pdfjs/${directory}/"`),
          `PDF.js ${directory} base URL must remain a relative directory without a query.`);
      }
    }
  }
  assert.ok(ownedImports >= 10, "The test must inspect the authored module graph, not only the HTML entry point.");
}

async function assertArtifactContainsNoSensitiveMaterial(manifest, outputRoot) {
  const forbiddenPath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:key|pem|p12|pfx|pdf|map))$/iu;
  const forbiddenContent = [
    /sourceMappingURL\s*=\s*data:/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bsb_secret_[A-Za-z0-9._-]{20,}\b/u,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /\b(?:DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY)\s*=\s*["']?[^\s"']{8,}/u,
  ];

  for (const record of manifest) {
    assert.doesNotMatch(record.path, forbiddenPath, `Forbidden generated artifact: ${record.path}`);
    const bytes = await readFile(path.join(outputRoot, ...record.path.split("/")));
    assert.notEqual(bytes.subarray(0, 5).toString("ascii"), "%PDF-", `PDF bytes were disguised as ${record.path}.`);
    const extension = path.extname(record.path).toLowerCase();
    if (![".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt", ".xml"].includes(extension)) continue;
    const source = bytes.toString("utf8");
    for (const pattern of forbiddenContent) {
      assert.doesNotMatch(source, pattern, `Credential-shaped content found in ${record.path}`);
    }
  }
}

test("release fingerprint changes with source bytes and locked package identity, not record order", () => {
  const sources = [
    { file: "spikes/webmcp-contract/app.mjs", bytes: Buffer.from("import './contracts.mjs';") },
    { file: "spikes/webmcp-contract/contracts.mjs", bytes: Buffer.from("export const version = 1;") },
    { file: "package-lock.json", bytes: Buffer.from('{"packages":{"graphology":"0.26.0"}}') },
  ];
  const fingerprint = createReleaseFingerprint(sources);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(createReleaseFingerprint([...sources].reverse()), fingerprint);
  assert.notEqual(createReleaseFingerprint(sources.map((record) => record.file.endsWith("contracts.mjs")
    ? { ...record, bytes: Buffer.from("export const version = 2;") } : record)), fingerprint);
  assert.notEqual(createReleaseFingerprint(sources.map((record) => record.file === "package-lock.json"
    ? { ...record, bytes: Buffer.from('{"packages":{"graphology":"0.27.0"}}') } : record)), fingerprint);
});

test("versions owned file literals consistently while preserving relative paths, parameters, and directory URLs", () => {
  const fingerprint = "a".repeat(64);
  const source = [
    'import { tool } from "./contracts.mjs?v=old&mode=reader#tools";',
    "export { state } from './interaction-state.mjs';",
    'const next = import("./structural-map.mjs");',
    'const worker = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url);',
    'const fonts = new URL("../vendor/pdfjs/standard_fonts/", import.meta.url);',
    'const external = "https://example.test/app.mjs?v=external";',
    'const unrelated = "./uploaded-paper.pdf";',
  ].join("\n");
  const versioned = versionDemoAssetReferences(source, "app.mjs", fingerprint);
  assert.ok(versioned.includes(`"./contracts.mjs?v=${fingerprint}&mode=reader#tools"`));
  assert.ok(versioned.includes(`'./interaction-state.mjs?v=${fingerprint}'`));
  assert.ok(versioned.includes(`import("./structural-map.mjs?v=${fingerprint}")`));
  assert.ok(versioned.includes(`"../vendor/pdfjs/pdf.worker.min.mjs?v=${fingerprint}"`));
  assert.ok(versioned.includes('"../vendor/pdfjs/standard_fonts/"'));
  assert.ok(versioned.includes('"https://example.test/app.mjs?v=external"'));
  assert.ok(versioned.includes('"./uploaded-paper.pdf"'));
  assert.equal(versionDemoAssetReferences(versioned, "app.mjs", fingerprint), versioned);
});

test("packages one byte-reproducible versioned module graph without changing sources or leaking maps, secrets, or PDFs", async () => {
  const originalSources = await authoredSourceManifest();
  const firstBuild = await packageWebmcpPages();
  const firstManifest = await artifactManifest(firstBuild.outputRoot);
  const packaged = await packageWebmcpPages();
  const secondManifest = await artifactManifest(packaged.outputRoot);
  assert.equal(packaged.fingerprint, firstBuild.fingerprint);
  assert.deepEqual(secondManifest, firstManifest, "Two clean Pages builds must emit byte-identical manifests.");
  assert.deepEqual(await authoredSourceManifest(), originalSources, "Packaging must not modify authored app source files.");
  await assertArtifactContainsNoSensitiveMaterial(secondManifest, packaged.outputRoot);

  const files = await collectFiles(packaged.outputRoot);
  const relativeFiles = files.map((file) => path.relative(packaged.outputRoot, file).replaceAll("\\", "/"));
  await assertReleaseReferences(packaged, relativeFiles);

  assert.ok(relativeFiles.includes("webmcp/index.html"));
  assert.ok(relativeFiles.includes("webmcp/app.mjs"));
  assert.ok(relativeFiles.includes("webmcp/accessibility-projection.mjs"));
  assert.ok(relativeFiles.includes("webmcp/activity-ledger.mjs"));
  assert.ok(relativeFiles.includes("webmcp/browser-snapshot.mjs"));
  assert.ok(relativeFiles.includes("webmcp/interaction-state.mjs"));
  assert.ok(relativeFiles.includes("webmcp/mentor-review.mjs"));
  assert.ok(relativeFiles.includes("webmcp/spatial-anchor.mjs"));
  assert.ok(relativeFiles.includes("webmcp/structural-map.mjs"));
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

test("Pages publication is gated by typecheck and both WebMCP suites and watches their configuration", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "pages.yml"), "utf8");
  const commands = [...workflow.matchAll(/^\s+run:\s*(.+)$/gmu)].map((match) => match[1].trim());
  const packageIndex = commands.indexOf("npm run webmcp:pages:build");
  assert.ok(packageIndex >= 0, "Pages must explicitly package after successful verification.");
  for (const command of ["npm run typecheck:webmcp", "npm run test:webmcp:contracts", "npm run test:webmcp:pages"]) {
    const commandIndex = commands.indexOf(command);
    assert.ok(commandIndex >= 0 && commandIndex < packageIndex, `${command} must gate packaging and deployment.`);
  }
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/u);
  assert.ok(workflow.indexOf("npm run webmcp:pages:build") < workflow.indexOf("uses: actions/upload-pages-artifact@"));
  for (const watchedPath of ["package.json", "package-lock.json", "tsconfig.webmcp.json", "scripts/package-webmcp-pages.test.mjs", "spikes/webmcp-contract/**"]) {
    assert.ok(workflow.includes(`      - "${watchedPath}"`), `Pages push filters must include ${watchedPath}.`);
  }
});

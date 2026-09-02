import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const defaultOutputRoot = path.join(repositoryRoot, ".paperpilot-pages");

const demoFiles = Object.freeze([
  "accessibility-projection.mjs",
  "activity-ledger.mjs",
  "index.html",
  "app.mjs",
  "browser-snapshot.mjs",
  "contracts.mjs",
  "graph-view-model.mjs",
  "interaction-state.mjs",
  "mentor-review.mjs",
  "paper-analysis.mjs",
  "pdf-viewer.mjs",
  "presentation-layout.mjs",
  "spatial-anchor.mjs",
  "structural-map.mjs",
  "webmcp-observer.mjs",
  "workspace-patch.mjs",
  "spike.css",
]);

const vendorFiles = Object.freeze([
  ["graphology/graphology.umd.min.js", "node_modules/graphology/dist/graphology.umd.min.js"],
  ["sigma/sigma.min.js", "node_modules/sigma/dist/sigma.min.js"],
  ["pdfjs/pdf.min.mjs", "node_modules/pdfjs-dist/build/pdf.min.mjs"],
  ["pdfjs/pdf.worker.min.mjs", "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"],
  ["pdfjs/pdf_viewer.css", "node_modules/pdfjs-dist/web/pdf_viewer.css"],
]);

const vendorDirectories = Object.freeze([
  ["pdfjs/standard_fonts", "node_modules/pdfjs-dist/standard_fonts"],
  ["pdfjs/cmaps", "node_modules/pdfjs-dist/cmaps"],
  ["pdfjs/wasm", "node_modules/pdfjs-dist/wasm"],
]);

const releaseIdentityFiles = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/package-webmcp-pages.mjs",
]);
const packagedAssetPaths = new Set([
  ...demoFiles.map((file) => `webmcp/${file}`),
  ...vendorFiles.map(([file]) => `vendor/${file}`),
]);

// Frame paths and raw byte lengths so the key is independent of enumeration order,
// output location, and clock time. The lockfile also invalidates vendor entry URLs.
export function createReleaseFingerprint(records) {
  const hash = createHash("sha256");
  hash.update("paperpilot-pages-release-v1\0");
  for (const { file, bytes } of [...records].sort((left, right) => (
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0
  ))) {
    hash.update(`${JSON.stringify([file, bytes.byteLength])}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// Version allowlisted file literals only. This covers module imports and HTML
// entry assets without rewriting authored files or PDF.js directory base URLs.
export function versionDemoAssetReferences(source, file, fingerprint) {
  return source.replace(/(["'])(\.\.?\/[^"'`\s<>]+)\1/gu, (match, quote, reference) => {
    const [beforeFragment, ...fragmentParts] = reference.split("#");
    const queryIndex = beforeFragment.indexOf("?");
    const pathname = queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex);
    const resolvedPath = path.posix.normalize(path.posix.join("webmcp", path.posix.dirname(file), pathname));
    if (!packagedAssetPaths.has(resolvedPath)) return match;
    const parameters = new URLSearchParams(queryIndex < 0 ? "" : beforeFragment.slice(queryIndex + 1));
    parameters.set("v", fingerprint);
    const fragment = fragmentParts.length ? `#${fragmentParts.join("#")}` : "";
    return `${quote}${pathname}?${parameters}${fragment}${quote}`;
  });
}

async function readReleaseSources() {
  const records = await Promise.all([
    ...demoFiles.map((file) => `spikes/webmcp-contract/${file}`),
    ...releaseIdentityFiles,
  ].map(async (file) => ({
    file,
    bytes: await readFile(path.join(repositoryRoot, file)),
  })));
  return {
    fingerprint: createReleaseFingerprint(records),
    demoSources: new Map(records
      .filter(({ file }) => file.startsWith("spikes/webmcp-contract/"))
      .map(({ file, bytes }) => [path.posix.basename(file), bytes.toString("utf8")])),
  };
}

function resolveOutputRoot(rawOutput = process.env.PAPERPILOT_PAGES_OUTPUT) {
  return path.resolve(rawOutput || defaultOutputRoot);
}

async function assertSourceFile(source) {
  const metadata = await stat(source);
  if (!metadata.isFile()) throw new Error(`Expected a file at ${source}.`);
}

async function copyFileInto(source, destination) {
  await assertSourceFile(source);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { force: true });
}

function assertSafeGeneratedOutput(outputRoot) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const resolvedOutputRoot = path.resolve(outputRoot);
  const relative = path.relative(resolvedRepositoryRoot, resolvedOutputRoot);
  if (
    !relative
    || relative.startsWith(`..${path.sep}`)
    || relative === ".."
    || path.isAbsolute(relative)
    || path.basename(resolvedOutputRoot) !== ".paperpilot-pages"
  ) {
    throw new Error("The Pages package may only replace the repository-local .paperpilot-pages directory.");
  }
}

async function assertPortableDemo(demoRoot) {
  const indexHtml = await readFile(path.join(demoRoot, "index.html"), "utf8");
  const sources = await Promise.all(demoFiles.map(async (file) => ({
    file,
    source: await readFile(path.join(demoRoot, file), "utf8"),
  })));
  const absoluteVendorReference = sources.find(({ source }) => (
    /(?:src|href)=["']\/vendor\//.test(source)
    || /from\s+["']\/vendor\//.test(source)
    || /["']\/vendor\//.test(source)
  ));
  if (absoluteVendorReference) {
    throw new Error(
      `The redesigned demo still uses a root-absolute /vendor URL in ${absoluteVendorReference.file}. Use module-relative ../vendor URLs for a repository-scoped Pages site.`,
    );
  }
  if (!indexHtml.includes('id="paper-file-input"')) {
    throw new Error("The public demo must gate initialization on a browser-local PDF file input.");
  }
}

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? collectFiles(absolute) : [absolute];
  }));
  return nested.flat();
}

async function assertNoPdfBytes(outputRoot) {
  const pdfFiles = (await collectFiles(outputRoot)).filter((file) => path.extname(file).toLowerCase() === ".pdf");
  if (pdfFiles.length > 0) {
    throw new Error(`The Pages artifact must not contain paper bytes: ${pdfFiles.join(", ")}`);
  }
}

export async function packageWebmcpPages({ outputRoot = resolveOutputRoot() } = {}) {
  assertSafeGeneratedOutput(outputRoot);
  // Capture once before replacing the generated output, so the hash describes
  // the exact source bytes being emitted, not a second read of mutable inputs.
  const { fingerprint, demoSources } = await readReleaseSources();
  await rm(outputRoot, { recursive: true, force: true });
  const demoRoot = path.join(outputRoot, "webmcp");
  const vendorRoot = path.join(outputRoot, "vendor");
  await mkdir(demoRoot, { recursive: true });

  for (const file of demoFiles) {
    await writeFile(
      path.join(demoRoot, file),
      versionDemoAssetReferences(demoSources.get(file), file, fingerprint),
      "utf8",
    );
  }
  for (const [destination, source] of vendorFiles) {
    await copyFileInto(path.join(repositoryRoot, source), path.join(vendorRoot, destination));
  }
  for (const [destination, source] of vendorDirectories) {
    await cp(path.join(repositoryRoot, source), path.join(vendorRoot, destination), {
      recursive: true,
      force: true,
    });
  }

  await assertPortableDemo(demoRoot);
  await assertNoPdfBytes(outputRoot);
  await writeFile(path.join(outputRoot, ".nojekyll"), "", "utf8");
  return { outputRoot, demoRoot, vendorRoot, fingerprint };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packaged = await packageWebmcpPages();
  console.log(`Packaged PaperPilot WebMCP demo at ${packaged.outputRoot} (release ${packaged.fingerprint})`);
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SYNTHETIC_PDF_FIXTURE_NAMES,
  createSyntheticPdfFixture,
} from "../spikes/webmcp-contract/test-support/synthetic-pdf-fixtures.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(repositoryRoot, "tmp", "pdfs", "structural-fixtures");
await mkdir(outputRoot, { recursive: true });

for (const name of SYNTHETIC_PDF_FIXTURE_NAMES) {
  const fixture = createSyntheticPdfFixture(name);
  const output = path.join(outputRoot, fixture.filename);
  await writeFile(output, fixture.bytes);
  console.log(JSON.stringify({
    name,
    path: output,
    pageCount: fixture.pageCount,
    bytes: fixture.byteLength,
    sha256: fixture.sha256,
    purpose: fixture.purpose,
  }));
}

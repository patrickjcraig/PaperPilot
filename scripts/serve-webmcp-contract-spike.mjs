import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 4175;
const SPIKE_ROUTE_PREFIX = "/webmcp-contract/";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const spikeRoot = path.join(repositoryRoot, "spikes", "webmcp-contract");
const packagedPagesRoot = path.join(repositoryRoot, ".paperpilot-pages");
const servePackagedPages = process.argv.slice(2).includes("--pages");

const vendorRoutes = new Map([
  [
    "/vendor/graphology/graphology.umd.min.js",
    path.join(repositoryRoot, "node_modules", "graphology", "dist", "graphology.umd.min.js"),
  ],
  [
    "/vendor/sigma/sigma.min.js",
    path.join(repositoryRoot, "node_modules", "sigma", "dist", "sigma.min.js"),
  ],
  [
    "/vendor/pdfjs/pdf.min.mjs",
    path.join(repositoryRoot, "node_modules", "pdfjs-dist", "build", "pdf.min.mjs"),
  ],
  [
    "/vendor/pdfjs/pdf.worker.min.mjs",
    path.join(repositoryRoot, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs"),
  ],
  [
    "/vendor/pdfjs/pdf_viewer.css",
    path.join(repositoryRoot, "node_modules", "pdfjs-dist", "web", "pdf_viewer.css"),
  ],
]);

const vendorDirectoryRoutes = Object.freeze([
  ["/vendor/pdfjs/standard_fonts/", path.join(repositoryRoot, "node_modules", "pdfjs-dist", "standard_fonts")],
  ["/vendor/pdfjs/cmaps/", path.join(repositoryRoot, "node_modules", "pdfjs-dist", "cmaps")],
  ["/vendor/pdfjs/wasm/", path.join(repositoryRoot, "node_modules", "pdfjs-dist", "wasm")],
]);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".pfb", "application/octet-stream"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

const securityHeaders = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy": [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self' blob: https://arxiv.org https://export.arxiv.org",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src-elem 'self'",
    "style-src-attr 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; "),
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

function parsePort(rawPort) {
  if (rawPort === undefined || rawPort === "") {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error("PAPERPILOT_WEBMCP_SPIKE_PORT must be an integer from 1 to 65535.");
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PAPERPILOT_WEBMCP_SPIKE_PORT must be an integer from 1 to 65535.");
  }

  return port;
}

function sendText(response, statusCode, message, extraHeaders = {}) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  response.end(body);
}

function isWithinDirectory(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function resolveSpikeFile(pathname) {
  if (pathname === "/" || pathname === "/webmcp-contract" || pathname === SPIKE_ROUTE_PREFIX) {
    return path.join(spikeRoot, "index.html");
  }

  let routePath = pathname;
  if (routePath.startsWith(SPIKE_ROUTE_PREFIX)) {
    routePath = `/${routePath.slice(SPIKE_ROUTE_PREFIX.length)}`;
  }

  if (!routePath.startsWith("/") || routePath.endsWith("/")) {
    return null;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(routePath);
  } catch {
    return null;
  }

  if (
    decodedPath.includes("\0") ||
    decodedPath.includes("\\") ||
    decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }

  const relativePath = decodedPath.slice(1);
  if (!relativePath || relativePath.startsWith(".")) {
    return null;
  }

  const candidate = path.resolve(spikeRoot, relativePath);
  return isWithinDirectory(candidate, spikeRoot) ? candidate : null;
}

function resolvePackagedFile(pathname) {
  let routePath = pathname;
  if (routePath === "/" || routePath === "/webmcp") routePath = "/webmcp/";
  if (routePath.endsWith("/")) routePath = `${routePath}index.html`;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(routePath);
  } catch {
    return null;
  }
  if (
    !decodedPath.startsWith("/")
    || decodedPath.includes("\0")
    || decodedPath.includes("\\")
    || decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  const relativePath = decodedPath.slice(1);
  if (!relativePath || relativePath.startsWith(".")) return null;
  const candidate = path.resolve(packagedPagesRoot, relativePath);
  return isWithinDirectory(candidate, packagedPagesRoot) ? candidate : null;
}

async function resolveRequestTarget(requestUrl) {
  let pathname;
  try {
    pathname = new URL(requestUrl, `http://${LOOPBACK_HOST}`).pathname;
  } catch {
    return null;
  }

  if (servePackagedPages) {
    const packagedTarget = resolvePackagedFile(pathname);
    if (!packagedTarget) return null;
    try {
      const metadata = await stat(packagedTarget);
      return metadata.isFile() ? packagedTarget : null;
    } catch {
      return null;
    }
  }

  const vendorTarget = vendorRoutes.get(pathname);
  if (vendorTarget) {
    return vendorTarget;
  }

  for (const [routePrefix, directory] of vendorDirectoryRoutes) {
    if (!pathname.startsWith(routePrefix)) continue;
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname.slice(routePrefix.length));
    } catch {
      return null;
    }
    if (
      !decodedPath ||
      decodedPath.includes("\0") ||
      decodedPath.includes("\\") ||
      decodedPath.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return null;
    }
    const candidate = path.resolve(directory, decodedPath);
    if (!isWithinDirectory(candidate, directory)) return null;
    try {
      const metadata = await stat(candidate);
      return metadata.isFile() ? candidate : null;
    } catch {
      return null;
    }
  }

  if (pathname.startsWith("/vendor/")) {
    return null;
  }

  const spikeTarget = resolveSpikeFile(pathname);
  if (!spikeTarget) {
    return null;
  }

  try {
    const metadata = await stat(spikeTarget);
    return metadata.isFile() ? spikeTarget : null;
  } catch {
    return null;
  }
}

const port = parsePort(process.env.PAPERPILOT_WEBMCP_SPIKE_PORT);

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
    return;
  }

  const target = await resolveRequestTarget(request.url ?? "/");
  if (!target) {
    sendText(response, 404, "Not Found");
    return;
  }

  let metadata;
  try {
    metadata = await stat(target);
  } catch {
    sendText(response, 404, "Not Found");
    return;
  }

  const contentType = contentTypes.get(path.extname(target).toLowerCase()) ?? "application/octet-stream";
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Length": metadata.size,
    "Content-Type": contentType,
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(target);
  stream.on("error", () => {
    if (!response.headersSent) {
      sendText(response, 500, "Internal Server Error");
    } else {
      response.destroy();
    }
  });
  stream.pipe(response);
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(port, LOOPBACK_HOST, () => {
  if (servePackagedPages) {
    console.log(`PaperPilot packaged Pages artifact: http://${LOOPBACK_HOST}:${port}/webmcp/`);
    console.log(`Serving only ${packagedPagesRoot}.`);
  } else {
    console.log(`PaperPilot WebMCP contract spike: http://${LOOPBACK_HOST}:${port}/`);
    console.log(`Serving only ${spikeRoot} plus pinned Graphology, Sigma, and PDF.js assets.`);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

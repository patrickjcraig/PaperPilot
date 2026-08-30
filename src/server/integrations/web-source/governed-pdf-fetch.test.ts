import assert from "node:assert/strict";
import test from "node:test";

import {
  GOVERNED_CRAWLER_RIGHTS_GRANT,
  GOVERNED_CRAWLER_USER_AGENT,
  GovernedCrawlerFetchError,
  GovernedPdfFetcher,
  governedRobotsAllows,
  type GovernedPdfFetchPolicy,
  type GovernedBeforePinnedRequest,
  type GovernedPinnedHttpsRequestInput,
  type GovernedPinnedHttpsRequester,
  type GovernedPinnedHttpsResponse,
  type GovernedWebSourceResolver,
} from "./governed-pdf-fetch";
import { CrawlerOriginRateLimitError } from "./crawler-rate-limit";

const ORIGIN = "https://repository.paperpilot.org";
const PDF_URL = `${ORIGIN}/papers/article.pdf`;
const PDF_BYTES = new TextEncoder().encode("%PDF");
const PUBLIC_ADDRESS = "8.8.8.8";

const POLICY: GovernedPdfFetchPolicy = {
  boundaries: [{ origin: ORIGIN, pathPrefix: "/papers", pathMatch: "prefix" }],
  rightsGrant: GOVERNED_CRAWLER_RIGHTS_GRANT,
  maximumBytes: 100,
  robotsUserAgent: "PaperPilotCrawler",
  maxRedirects: 0,
  maxDnsAddresses: 8,
  dnsLookupTimeoutMs: 100,
  maxResponseHeaderBytes: 32 * 1_024,
  responseHeaderTimeoutMs: 100,
  responseIdleTimeoutMs: 100,
  absoluteDeadlineMs: 1_000,
};

function headers(
  values: Readonly<Record<string, string | readonly string[]>>,
): ReadonlyArray<readonly [string, string]> {
  return Object.entries(values).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((entry) => [name, entry] as const));
}

function response(input: {
  status?: number;
  headers?: Readonly<Record<string, string | readonly string[]>>;
  bytes?: Uint8Array;
  keepOpen?: boolean;
  onCancel?: () => void;
  onClose?: () => void;
} = {}): GovernedPinnedHttpsResponse {
  const bytes = input.bytes ?? new Uint8Array();
  let closed = false;
  return {
    statusCode: input.status ?? 200,
    headers: headers(input.headers ?? {}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) controller.enqueue(bytes);
        if (!input.keepOpen) controller.close();
      },
      cancel() {
        input.onCancel?.();
      },
    }),
    close() {
      if (closed) return;
      closed = true;
      input.onClose?.();
    },
  };
}

function pdfResponse(overrides: {
  bytes?: Uint8Array;
  headers?: Readonly<Record<string, string | readonly string[]>>;
  keepOpen?: boolean;
  onCancel?: () => void;
  onClose?: () => void;
} = {}): GovernedPinnedHttpsResponse {
  const bytes = overrides.bytes ?? PDF_BYTES;
  return response({
    bytes,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.byteLength),
      ...overrides.headers,
    },
    keepOpen: overrides.keepOpen,
    onCancel: overrides.onCancel,
    onClose: overrides.onClose,
  });
}

const PUBLIC_RESOLVER: GovernedWebSourceResolver = async () => [{
  address: PUBLIC_ADDRESS,
  family: 4,
}];

function fetcher(
  requester: GovernedPinnedHttpsRequester,
  resolver: GovernedWebSourceResolver = PUBLIC_RESOLVER,
  beforePinnedRequest?: GovernedBeforePinnedRequest,
): GovernedPdfFetcher {
  return new GovernedPdfFetcher({
    requester,
    resolver,
    beforePinnedRequest,
    now: () => new Date("2026-08-29T16:00:00.000Z"),
  });
}

async function read(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function rejectsCode(
  operation: Promise<unknown>,
  code: string,
): Promise<GovernedCrawlerFetchError> {
  let captured: GovernedCrawlerFetchError | undefined;
  await assert.rejects(operation, (caught: unknown) => {
    assert.ok(caught instanceof GovernedCrawlerFetchError);
    assert.equal(caught.code, code);
    assert.equal(caught.message.includes(PUBLIC_ADDRESS), false);
    assert.equal(caught.message.includes(PDF_URL), false);
    captured = caught;
    return true;
  });
  assert.ok(captured);
  return captured;
}

test("pins every robots and PDF connection while preserving Host, SNI, and minimal headers", async () => {
  const requests: GovernedPinnedHttpsRequestInput[] = [];
  const admittedHostnames: string[] = [];
  const requester: GovernedPinnedHttpsRequester = async (request) => {
    requests.push(request);
    return request.path === "/robots.txt"
      ? response({ status: 404 })
      : pdfResponse();
  };
  const result = await fetcher(requester, PUBLIC_RESOLVER, async ({ hostname }) => {
    admittedHostnames.push(hostname);
  }).fetch({ url: PDF_URL, policy: POLICY });

  assert.deepEqual(await read(result.body), PDF_BYTES);
  assert.equal(result.expectedSizeBytes, 4n);
  assert.equal(requests.length, 2);
  assert.deepEqual(admittedHostnames, [
    "repository.paperpilot.org",
    "repository.paperpilot.org",
  ]);
  for (const request of requests) {
    assert.equal(request.destinationAddress, PUBLIC_ADDRESS);
    assert.equal(request.destinationFamily, 4);
    assert.equal(request.servername, "repository.paperpilot.org");
    assert.equal(request.hostHeader, "repository.paperpilot.org");
    assert.equal(request.method, "GET");
    assert.equal(request.headers["Accept-Encoding"], "identity");
    assert.equal(request.headers["User-Agent"], GOVERNED_CRAWLER_USER_AGENT);
    assert.equal(Object.keys(request.headers).some((name) =>
      /authorization|cookie|proxy|referer/i.test(name)), false);
  }
  assert.equal(requests[0]?.path, "/robots.txt");
  assert.equal(requests[1]?.path, "/papers/article.pdf");
  assert.deepEqual(result.receipt, {
    schemaVersion: 1,
    requestedUrlSha256: result.receipt.requestedUrlSha256,
    finalUrlSha256: result.receipt.finalUrlSha256,
    redirectChainSha256: result.receipt.redirectChainSha256,
    redirectCount: 0,
    robotsCheckCount: 1,
    pinnedConnectionCount: 2,
    retrievedAt: "2026-08-29T16:00:00.000Z",
    contentType: "application/pdf",
    contentEncoding: "identity",
    contentLength: 4,
    userAgent: GOVERNED_CRAWLER_USER_AGENT,
  });
  assert.match(result.receipt.requestedUrlSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result.receipt).includes(PDF_URL), false);
  assert.equal(JSON.stringify(result.receipt).includes(PUBLIC_ADDRESS), false);
});

test("first mode rejects queries, non-443 ports, credentials, fragments, and ambiguous or oversized paths", async () => {
  let requests = 0;
  const client = fetcher(async () => {
    requests += 1;
    return pdfResponse();
  });
  const invalid = [
    `${PDF_URL}?download=1`,
    `${PDF_URL}?`,
    "https://repository.paperpilot.org:444/papers/article.pdf",
    "https://user:super-secret@repository.paperpilot.org/papers/article.pdf",
    `${PDF_URL}#page=1`,
    `${PDF_URL}#`,
    "https://@repository.paperpilot.org/papers/article.pdf",
    "https://repository.paperpilot.org/papers/../private/article.pdf",
    `https://repository.paperpilot.org/papers/${"a".repeat(1_025)}`,
  ];
  for (const url of invalid) {
    const failure = await rejectsCode(
      client.fetch({ url, policy: POLICY }),
      "crawler_url_invalid",
    );
    assert.equal(failure.message.includes("super-secret"), false);
  }
  assert.equal(requests, 0);

  await rejectsCode(client.fetch({
    url: "https://repository.paperpilot.org/outside/article.pdf",
    policy: POLICY,
  }), "crawler_policy_denied");
  assert.equal(requests, 0);
});

test("requires an explicit indefinite-custody grant and bounded trusted policy", async () => {
  const client = fetcher(async () => pdfResponse());
  await rejectsCode(client.fetch({
    url: PDF_URL,
    policy: {
      ...POLICY,
      rightsGrant: "finite" as typeof GOVERNED_CRAWLER_RIGHTS_GRANT,
    },
  }), "crawler_request_invalid");
  await rejectsCode(client.fetch({
    url: PDF_URL,
    policy: { ...POLICY, maximumBytes: 0 },
  }), "crawler_request_invalid");
});

test("rejects mixed public/private DNS answers before opening a socket", async () => {
  let requests = 0;
  const resolver: GovernedWebSourceResolver = async () => [
    { address: PUBLIC_ADDRESS, family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await rejectsCode(fetcher(async () => {
    requests += 1;
    return pdfResponse();
  }, resolver).fetch({ url: PDF_URL, policy: POLICY }), "crawler_dns_rejected");
  assert.equal(requests, 0);
});

test("re-resolves before the PDF socket and blocks a DNS rebinding answer", async () => {
  let resolutions = 0;
  let requests = 0;
  const resolver: GovernedWebSourceResolver = async () => {
    resolutions += 1;
    return resolutions === 1
      ? [{ address: PUBLIC_ADDRESS, family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }];
  };
  await rejectsCode(fetcher(async () => {
    requests += 1;
    return response({ status: 404 });
  }, resolver).fetch({ url: PDF_URL, policy: POLICY }), "crawler_dns_rejected");
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

test("specific crawler robots rules outrank wildcard groups and longest allow wins ties", async () => {
  const robots = [
    "User-agent: *",
    "Allow: /",
    "",
    "User-agent: PaperPilotCrawler/1.0",
    "Disallow: /papers",
    "Allow: /papers/open",
  ].join("\n");
  assert.equal(governedRobotsAllows(robots, "/papers/private/article.pdf"), false);
  assert.equal(governedRobotsAllows(robots, "/papers/open/article.pdf"), true);
  assert.equal(governedRobotsAllows("User-agent: *\nDisallow: /papers", "/papers/a"), false);
  assert.equal(
    governedRobotsAllows("User-agent: *\nDisallow: /*.pdf$", "/papers/a.pdf"),
    false,
  );
  assert.equal(
    governedRobotsAllows(
      "User-agent: PaperPilotCrawler\nDisallow: /foo/bar/%62%61%7A",
      "/foo/bar/baz/article.pdf",
      "PaperPilotCrawler",
    ),
    false,
  );
  assert.equal(
    governedRobotsAllows(
      "User-agent: PaperPilotCrawler\nDisallow: /caf%C3%A9",
      "/café/article.pdf",
      "PaperPilotCrawler",
    ),
    false,
  );
  assert.equal(
    governedRobotsAllows(
      "User-agent: PaperPilotCrawler\nDisallow: /café",
      "/caf%C3%A9/article.pdf",
      "PaperPilotCrawler",
    ),
    false,
  );

  let calls = 0;
  const requester: GovernedPinnedHttpsRequester = async () => {
    calls += 1;
    return response({
      status: 200,
      bytes: new TextEncoder().encode(robots),
      headers: { "Content-Length": String(Buffer.byteLength(robots)) },
    });
  };
  await rejectsCode(fetcher(requester).fetch({
    url: `${ORIGIN}/papers/private/article.pdf`,
    policy: POLICY,
  }), "crawler_robots_denied");
  assert.equal(calls, 1);
});

test("manually revalidates an allowed redirect and rejects an origin escape", async () => {
  const requests: GovernedPinnedHttpsRequestInput[] = [];
  const allowedRequester: GovernedPinnedHttpsRequester = async (request) => {
    requests.push(request);
    if (request.path === "/robots.txt") return response({ status: 404 });
    if (request.path === "/papers/article.pdf") {
      return response({
        status: 302,
        headers: { Location: "/papers/final.pdf" },
      });
    }
    return pdfResponse();
  };
  const redirected = await fetcher(allowedRequester).fetch({
    url: PDF_URL,
    policy: { ...POLICY, maxRedirects: 1 },
  });
  assert.deepEqual(await read(redirected.body), PDF_BYTES);
  assert.equal(redirected.receipt.redirectCount, 1);
  assert.equal(redirected.receipt.robotsCheckCount, 2);
  assert.equal(redirected.receipt.pinnedConnectionCount, 4);
  assert.deepEqual(requests.map(({ path }) => path), [
    "/robots.txt",
    "/papers/article.pdf",
    "/robots.txt",
    "/papers/final.pdf",
  ]);

  let escapedBodyCancelled = false;
  let calls = 0;
  const escapeRequester: GovernedPinnedHttpsRequester = async (request) => {
    calls += 1;
    if (request.path === "/robots.txt") return response({ status: 404 });
    return response({
      status: 302,
      headers: { Location: "https://attacker.invalid/private.pdf" },
      keepOpen: true,
      onCancel: () => { escapedBodyCancelled = true; },
    });
  };
  await rejectsCode(fetcher(escapeRequester).fetch({
    url: PDF_URL,
    policy: POLICY,
  }), "crawler_redirect_rejected");
  assert.equal(calls, 2);
  assert.equal(escapedBodyCancelled, true);
});

test("rejects a robots redirect escape without resolving or contacting its destination", async () => {
  let resolutions = 0;
  let requests = 0;
  const resolver: GovernedWebSourceResolver = async () => {
    resolutions += 1;
    return [{ address: PUBLIC_ADDRESS, family: 4 }];
  };
  const requester: GovernedPinnedHttpsRequester = async () => {
    requests += 1;
    return response({
      status: 302,
      headers: { Location: "https://attacker.invalid/robots.txt" },
    });
  };
  await rejectsCode(fetcher(requester, resolver).fetch({
    url: PDF_URL,
    policy: POLICY,
  }), "crawler_robots_denied");
  assert.equal(resolutions, 1);
  assert.equal(requests, 1);
});

test("allows at most three fully revalidated PDF redirects", async () => {
  let pdfRequests = 0;
  let totalRequests = 0;
  const requester: GovernedPinnedHttpsRequester = async (request) => {
    totalRequests += 1;
    if (request.path === "/robots.txt") return response({ status: 404 });
    pdfRequests += 1;
    return response({
      status: 302,
      headers: { Location: `/papers/redirect-${pdfRequests}.pdf` },
    });
  };
  await rejectsCode(fetcher(requester).fetch({
    url: PDF_URL,
    policy: { ...POLICY, maxRedirects: 3 },
  }), "crawler_redirect_rejected");
  assert.equal(pdfRequests, 4);
  assert.equal(totalRequests, 8);
});

test("rejects oversized, encoded, parameterized, and ambiguously framed PDF responses", async () => {
  const cases: Array<{
    response: GovernedPinnedHttpsResponse;
    code: string;
  }> = [
    {
      response: pdfResponse({ headers: { "Content-Length": "101" } }),
      code: "crawler_response_too_large",
    },
    {
      response: pdfResponse({ headers: { "Content-Encoding": "gzip" } }),
      code: "crawler_bad_response",
    },
    {
      response: pdfResponse({ headers: { "Content-Type": "application/pdf; charset=binary" } }),
      code: "crawler_bad_response",
    },
    {
      response: pdfResponse({ headers: { "Transfer-Encoding": "chunked" } }),
      code: "crawler_bad_response",
    },
    {
      response: pdfResponse({ headers: { "Content-Length": ["4", "4"] } }),
      code: "crawler_bad_response",
    },
    {
      response: pdfResponse({ headers: { "X-Oversized": "a".repeat(33 * 1_024) } }),
      code: "crawler_bad_response",
    },
  ];
  for (const entry of cases) {
    let calls = 0;
    const requester: GovernedPinnedHttpsRequester = async (request) => {
      calls += 1;
      return request.path === "/robots.txt" ? response({ status: 404 }) : entry.response;
    };
    await rejectsCode(fetcher(requester).fetch({ url: PDF_URL, policy: POLICY }), entry.code);
    assert.equal(calls, 2);
  }
});

test("counts streamed bytes and rejects bodies that exceed or undershoot Content-Length", async () => {
  let oversizedCancelled = false;
  let oversizedClosed = false;
  const oversizedRequester: GovernedPinnedHttpsRequester = async (request) =>
    request.path === "/robots.txt"
      ? response({ status: 404 })
      : pdfResponse({
          bytes: new TextEncoder().encode("%PDF!"),
          headers: { "Content-Length": "4" },
          keepOpen: true,
          onCancel: () => { oversizedCancelled = true; },
          onClose: () => { oversizedClosed = true; },
        });
  const oversized = await fetcher(oversizedRequester).fetch({ url: PDF_URL, policy: POLICY });
  await rejectsCode(read(oversized.body), "crawler_response_too_large");
  assert.equal(oversizedCancelled, true);
  assert.equal(oversizedClosed, true);

  const shortRequester: GovernedPinnedHttpsRequester = async (request) =>
    request.path === "/robots.txt"
      ? response({ status: 404 })
      : pdfResponse({ headers: { "Content-Length": "5" } });
  const short = await fetcher(shortRequester).fetch({ url: PDF_URL, policy: POLICY });
  await rejectsCode(read(short.body), "crawler_bad_response");
});

test("bounded phase deadlines cover stalled requests and stalled response bodies", async () => {
  let requestSignal: AbortSignal | undefined;
  const stalledRequester: GovernedPinnedHttpsRequester = (request) => {
    requestSignal = request.signal;
    return new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("private failure")), {
        once: true,
      });
    });
  };
  await rejectsCode(fetcher(stalledRequester).fetch({
    url: PDF_URL,
    policy: POLICY,
  }), "crawler_timeout");
  assert.equal(requestSignal?.aborted, true);

  let streamCancelled = false;
  let streamClosed = false;
  const bodyRequester: GovernedPinnedHttpsRequester = async (request) => {
    if (request.path === "/robots.txt") return response({ status: 404 });
    return {
      statusCode: 200,
      headers: headers({
        "Content-Type": "application/pdf",
        "Content-Length": "4",
      }),
      body: new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => undefined);
        },
        cancel() {
          streamCancelled = true;
        },
      }),
      close() {
        streamClosed = true;
      },
    };
  };
  const stalledBody = await fetcher(bodyRequester).fetch({
    url: PDF_URL,
    policy: POLICY,
  });
  await rejectsCode(read(stalledBody.body), "crawler_timeout");
  assert.equal(streamCancelled, true);
  assert.equal(streamClosed, true);
});

test("a crawler-origin rate denial is preserved with its exact retry time", async () => {
  const retryAt = new Date("2026-08-29T16:01:17.000Z");
  let requests = 0;
  const pending = fetcher(
    async () => {
      requests += 1;
      return response({ status: 404 });
    },
    PUBLIC_RESOLVER,
    async () => {
      throw new CrawlerOriginRateLimitError(77, retryAt);
    },
  ).fetch({ url: PDF_URL, policy: POLICY });

  await assert.rejects(pending, (caught: unknown) => {
    assert.ok(caught instanceof CrawlerOriginRateLimitError);
    assert.equal(caught.retryAfterSeconds, 77);
    assert.equal(caught.retryAt, retryAt);
    return true;
  });
  assert.equal(requests, 0);
});

test("external cancellation is sanitized and prevents a late network result", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  let enteredRequester: (() => void) | undefined;
  const requesterEntered = new Promise<void>((resolve) => {
    enteredRequester = resolve;
  });
  const requester: GovernedPinnedHttpsRequester = (request) => {
    observedSignal = request.signal;
    enteredRequester?.();
    return new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("https://private.invalid")), {
        once: true,
      });
    });
  };
  const pending = fetcher(requester).fetch({
    url: PDF_URL,
    policy: POLICY,
    signal: controller.signal,
  });
  await requesterEntered;
  controller.abort("private cancellation reason");
  const failure = await rejectsCode(pending, "crawler_cancelled");
  assert.equal(observedSignal?.aborted, true);
  assert.equal(failure.message.includes("private"), false);
});

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpProblem";
  }
}

export function problemResponse(error: unknown, requestId: string): Response {
  const problem = error instanceof HttpProblem
    ? error
    : new HttpProblem(500, "internal_error", "PaperPilot could not complete this request.");

  return Response.json(
    {
      error: {
        code: problem.code,
        message: problem.message,
        requestId,
      },
    },
    {
      status: problem.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    },
  );
}

export function requestIdFrom(request: Request): string {
  const candidate = request.headers.get("x-request-id")?.trim();
  if (candidate && /^[a-zA-Z0-9._:-]{1,100}$/.test(candidate)) return candidate;
  return crypto.randomUUID();
}


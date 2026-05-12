import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import { isDev } from "./env";
import { logger } from "./logger";
import {
  checkRateLimit,
  getClientIp,
  type RateLimitConfig,
} from "./rate-limit";

// ---------------------------------------------------------------------------
// Typed API error — lets handlers throw meaningful HTTP responses
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, msg, details);
export const unauthorized = (msg = "Unauthorized") => new ApiError(401, msg);
export const forbidden = (msg = "Forbidden") => new ApiError(403, msg);
export const notFound = (msg = "Not found") => new ApiError(404, msg);
export const conflict = (msg: string) => new ApiError(409, msg);
export const paymentRequired = (msg: string) => new ApiError(402, msg);
export const tooManyRequests = (msg = "Too many requests", retryAfterSec = 0) =>
  new ApiError(429, msg, { retryAfterSec });
export const serviceUnavailable = (msg = "Service unavailable") =>
  new ApiError(503, msg);

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------
function errorResponse(status: number, message: string, details?: unknown) {
  return NextResponse.json(
    { error: message, ...(details !== undefined ? { details } : {}) },
    { status },
  );
}

// ---------------------------------------------------------------------------
// Wrap a handler with validation + error handling + optional rate limiting
// ---------------------------------------------------------------------------

type Ctx<TBody, TQuery> = {
  req: NextRequest;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
};

type HandlerOpts<
  TBodySchema extends z.ZodType | undefined,
  TQuerySchema extends z.ZodType | undefined,
> = {
  body?: TBodySchema;
  query?: TQuerySchema;
  rateLimit?: RateLimitConfig;
};

type InferOrUndefined<T> = T extends z.ZodType ? z.infer<T> : undefined;

export function handler<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
>(
  opts: HandlerOpts<TBodySchema, TQuerySchema>,
  fn: (
    ctx: Ctx<InferOrUndefined<TBodySchema>, InferOrUndefined<TQuerySchema>>,
  ) => Promise<Response | NextResponse>,
) {
  return async (
    req: NextRequest,
    context?: { params?: Promise<Record<string, string>> },
  ): Promise<Response | NextResponse> => {
    const method = req.method;
    const route = new URL(req.url).pathname;
    const log = logger.child({ route, method });
    const started = Date.now();

    try {
      // Rate limit (per-IP + route)
      if (opts.rateLimit && process.env.PLAYWRIGHT_TEST !== "true") {
        const ip = getClientIp(req.headers);
        const key = `${ip}:${method}:${route}`;
        const result = checkRateLimit(key, opts.rateLimit);
        if (!result.allowed) {
          log.warn("rate limit exceeded", { ip, retryAfterSec: result.retryAfterSec });
          const res = errorResponse(429, "Too many requests");
          res.headers.set("Retry-After", String(result.retryAfterSec));
          return res;
        }
      }

      // Parse body (if schema given)
      let body: unknown = undefined;
      if (opts.body) {
        const raw = await req.json().catch(() => {
          throw badRequest("Invalid JSON body");
        });
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) {
          throw badRequest("Validation failed", parsed.error.flatten());
        }
        body = parsed.data;
      }

      // Parse query (if schema given)
      let query: unknown = undefined;
      if (opts.query) {
        const searchParams = Object.fromEntries(req.nextUrl.searchParams);
        const parsed = opts.query.safeParse(searchParams);
        if (!parsed.success) {
          throw badRequest("Invalid query params", parsed.error.flatten());
        }
        query = parsed.data;
      }

      const params = (await context?.params) ?? {};

      const res = await fn({
        req,
        body: body as InferOrUndefined<TBodySchema>,
        query: query as InferOrUndefined<TQuerySchema>,
        params,
      });

      log.debug("ok", { status: res.status, ms: Date.now() - started });
      return res;
    } catch (err) {
      const ms = Date.now() - started;

      if (err instanceof ApiError) {
        // 4xx errors are expected — log at info/debug level
        if (err.status >= 500) {
          log.error("handler threw 5xx ApiError", { status: err.status, msg: err.message, ms });
        } else {
          log.debug("handler rejected", { status: err.status, msg: err.message, ms });
        }
        return errorResponse(err.status, err.message, err.details);
      }
      if (err instanceof ZodError) {
        log.debug("zod validation failed", { ms });
        return errorResponse(400, "Validation failed", err.flatten());
      }
      // Prisma unique constraint violation → 409. Duck-typed so we don't
      // import Prisma runtime classes into the API-handler module.
      if (
        err instanceof Error &&
        (err as { code?: string }).code === "P2002"
      ) {
        log.debug("prisma unique violation", { ms });
        return errorResponse(409, "Duplicate — this record already exists");
      }
      // QB auth / connectivity failure → 503. Duck-typed via err.name so
      // we don't create a circular import from quickbooks.ts.
      if (err instanceof Error && err.name === "QBAuthError") {
        log.error("QB auth failure", { msg: err.message, ms });
        return errorResponse(
          503,
          "Payment service temporarily unavailable. Please try again in a moment."
        );
      }
      // Unknown error — never leak details in prod
      log.error("unhandled exception", {
        ms,
        err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      const message = isDev && err instanceof Error ? err.message : "Internal server error";
      return errorResponse(500, message);
    }
  };
}

// Convenience JSON response helper
export const json = <T>(data: T, init?: ResponseInit) =>
  NextResponse.json(data, init);

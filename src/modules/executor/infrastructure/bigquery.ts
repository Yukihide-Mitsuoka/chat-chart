// BigQuery QueryRunner over the REST jobs.query endpoint.
//
// Uses fetch rather than @google-cloud/bigquery deliberately: the official
// client pulls 48 packages (+563 lockfile lines, over the GR-020 hard limit in
// one PR), while the surface we need here is one endpoint. Credentials still
// come from google-auth-library — hand-rolling service-account OAuth would be
// the wrong thing to own.
//
// Values are ALWAYS sent as named query parameters. Interpolating them into the
// SQL text would undo the AST binding the domain layer just applied.
import type { ParamValue, QueryRunner } from '../application/ports.ts';

export interface AccessTokenProvider {
  getToken(): Promise<string>;
}

/** The slice of fetch this adapter uses — injectable so tests need no network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface BigQueryRunnerOptions {
  readonly projectId: string;
  readonly tokens: AccessTokenProvider;
  readonly fetchImpl?: FetchLike;
  /** Rows beyond this are a hard error, never a silent truncation. */
  readonly maxRows?: number;
  readonly location?: string;
  readonly timeoutMs?: number;
}

interface BqField {
  name?: string;
  type?: string;
}
interface BqCell {
  v?: unknown;
}
interface BqRow {
  f?: BqCell[];
}
interface BqResponse {
  jobComplete?: boolean;
  schema?: { fields?: BqField[] };
  rows?: BqRow[];
  pageToken?: string;
  totalRows?: string;
  error?: { message?: string };
  errors?: { message?: string }[];
}

function queryParameter(name: string, value: ParamValue) {
  const type =
    typeof value === 'boolean'
      ? 'BOOL'
      : typeof value === 'number'
        ? Number.isInteger(value)
          ? 'INT64'
          : 'FLOAT64'
        : 'STRING';
  return {
    name,
    parameterType: { type },
    parameterValue: { value: String(value) },
  };
}

/** BigQuery returns every value as a string; restore the schema's type. */
function decodeCell(raw: unknown, type: string | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw; // nested/repeated values pass through
  switch (type) {
    case 'INTEGER':
    case 'INT64': {
      const n = Number(raw);
      // Keep the string when the value cannot survive as a JS number.
      return Number.isSafeInteger(n) ? n : raw;
    }
    case 'FLOAT':
    case 'FLOAT64':
    case 'NUMERIC':
    case 'BIGNUMERIC': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'BOOLEAN':
    case 'BOOL':
      return raw === 'true';
    default:
      return raw;
  }
}

export class BigQueryRunner implements QueryRunner {
  readonly #o: BigQueryRunnerOptions;
  readonly #fetch: FetchLike;
  readonly #maxRows: number;

  constructor(options: BigQueryRunnerOptions) {
    this.#o = options;
    this.#fetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.#maxRows = options.maxRows ?? 10_000;
  }

  async run(
    sql: string,
    params: Readonly<Record<string, ParamValue>>,
  ): Promise<{ ok: true; rows: readonly unknown[] } | { ok: false; reason: string }> {
    const body = {
      query: sql,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: Object.entries(params).map(([k, v]) => queryParameter(k, v)),
      maxResults: this.#maxRows,
      timeoutMs: this.#o.timeoutMs ?? 30_000,
      ...(this.#o.location !== undefined && { location: this.#o.location }),
    };

    let token: string;
    try {
      token = await this.#o.tokens.getToken();
    } catch (e) {
      return { ok: false, reason: `credentials unavailable: ${message(e)}` };
    }

    let raw: string;
    let httpOk: boolean;
    let status: number;
    try {
      const res = await this.#fetch(
        `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(
          this.#o.projectId,
        )}/queries`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      httpOk = res.ok;
      status = res.status;
      raw = await res.text();
    } catch (e) {
      return { ok: false, reason: `request failed: ${message(e)}` };
    }

    let parsed: BqResponse;
    try {
      parsed = JSON.parse(raw) as BqResponse;
    } catch {
      return { ok: false, reason: `unparsable response (HTTP ${status})` };
    }
    if (!httpOk) {
      return { ok: false, reason: parsed.error?.message ?? `HTTP ${status}` };
    }
    const firstError = parsed.errors?.[0]?.message;
    if (firstError !== undefined) return { ok: false, reason: firstError };
    if (parsed.jobComplete === false) {
      // Returning the partial result would look like a complete answer.
      return { ok: false, reason: 'query did not complete within the timeout' };
    }
    if (parsed.pageToken !== undefined) {
      return {
        ok: false,
        reason: `result exceeds maxRows (${this.#maxRows}); refine the query`,
      };
    }

    const fields = parsed.schema?.fields ?? [];
    const rows = (parsed.rows ?? []).map((row) => {
      const out: Record<string, unknown> = {};
      fields.forEach((field, i) => {
        const name = field.name ?? `f${i}`;
        out[name] = decodeCell(row.f?.[i]?.v, field.type);
      });
      return out;
    });
    return { ok: true, rows };
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

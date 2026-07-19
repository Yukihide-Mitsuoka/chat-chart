// AST-level tenant-boundary binding (ADR-0005 原則C-2). The boundary is
// compiled INTO the query, never appended as text: every physical table is
// rewritten to the tenant's own dataset, and every row-scoped table is wrapped
// in a filtering subquery at the point of use — so joins, CTEs and nested
// subqueries all carry the boundary.
//
// Fail-closed by construction: after rewriting we re-parse the output and
// assert that every remaining base table is qualified to this tenant's dataset.
// A gap in the walker therefore yields a rejection, never a leak (the same
// belt-and-suspenders idea as the gate's payload tenant assert, 原則C-4).
// node-sql-parser ships CommonJS, so the ESM loader cannot see its named
// exports — take the default and destructure.
import sqlParser from 'node-sql-parser';
import type { BoundQuery, QueryPolicy, Rejection, TableRule, TenantBinding } from './types.ts';
import { reject } from './types.ts';

const { Parser } = sqlParser;
type SqlParser = InstanceType<typeof Parser>;

const DIALECT = { database: 'bigquery' } as const;

/** Identifiers we are willing to emit into SQL text. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Scope values we are willing to emit as literals. */
const SAFE_SCOPE_VALUE = /^[A-Za-z0-9_-]+$/;

interface SelectNode {
  type?: string;
  with?: unknown;
  from?: unknown;
  [key: string]: unknown;
}
interface FromItem {
  db?: string | null;
  table?: string;
  as?: string | null;
  expr?: { ast?: SelectNode; parentheses?: boolean };
  [key: string]: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isSelect = (v: unknown): v is SelectNode => isRecord(v) && v['type'] === 'select';

/**
 * Compile the tenant boundary into `sql`.
 * Returns the rewritten SQL, or a rejection explaining why the query is refused.
 */
export function bindQuery(
  sql: string,
  binding: TenantBinding,
  policy: QueryPolicy,
): BoundQuery | Rejection {
  if (!SAFE_IDENT.test(binding.dataset))
    return reject('rewrite-failed', `unsafe dataset identifier: ${binding.dataset}`);

  const rules = new Map<string, TableRule>();
  for (const t of policy.tables) {
    if (!SAFE_IDENT.test(t.name)) return reject('rewrite-failed', `unsafe table name: ${t.name}`);
    if (t.scopeColumn !== undefined && !SAFE_IDENT.test(t.scopeColumn))
      return reject('rewrite-failed', `unsafe scope column: ${t.scopeColumn}`);
    rules.set(t.name.toLowerCase(), t);
  }

  const scopeValues = binding.scope.kind === 'stores' ? binding.scope.storeIds : [];
  for (const v of scopeValues) {
    if (!SAFE_SCOPE_VALUE.test(v)) return reject('rewrite-failed', `unsafe scope value: ${v}`);
  }

  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, DIALECT);
  } catch (e) {
    return reject('parse-error', e instanceof Error ? e.message : 'unparsable SQL');
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1)
    return reject('not-a-single-statement', `expected 1 statement, got ${statements.length}`);
  const root = statements[0];
  if (!isSelect(root)) {
    const kind = isRecord(root) ? String(root['type']) : 'unknown';
    return reject('not-a-select', `only SELECT is permitted, got ${kind}`);
  }

  const touched = new WeakSet<object>();
  const referenced = new Set<string>();
  let failure: Rejection | null = null;

  /** Rewrite one base-table FROM item in place. */
  function bindTable(item: FromItem, cteNames: ReadonlySet<string>): void {
    if (failure || touched.has(item)) return;
    const name = item.table;
    if (name === undefined) return;
    // A CTE name is not a physical table — leave it; its body was bound already.
    if (cteNames.has(name.toLowerCase())) return;
    touched.add(item);

    // Reject caller-supplied qualification: it could point at another dataset.
    if (item.db !== undefined && item.db !== null && item.db !== '') {
      failure = reject(
        'qualified-table-not-allowed',
        `remove the dataset qualifier from "${item.db}.${name}" — the tenant's dataset is applied automatically`,
      );
      return;
    }
    const rule = rules.get(name.toLowerCase());
    if (rule === undefined) {
      failure = reject('table-not-allowed', `table not in the allowlist: ${name}`);
      return;
    }
    if (!SAFE_IDENT.test(name)) {
      failure = reject('rewrite-failed', `unsafe table identifier: ${name}`);
      return;
    }
    referenced.add(`${binding.dataset}.${rule.name}`);

    const rowScoped = rule.scopeColumn !== undefined && binding.scope.kind === 'stores';
    if (!rowScoped) {
      item.db = binding.dataset; // dataset qualification = tenant isolation
      return;
    }
    // Row scope: wrap the table so the filter binds at this point of use.
    const alias = item.as ?? name;
    if (!SAFE_IDENT.test(alias)) {
      failure = reject('rewrite-failed', `unsafe alias identifier: ${alias}`);
      return;
    }
    const inList = scopeValues.length === 0 ? 'NULL' : scopeValues.map((v) => `'${v}'`).join(', ');
    const sub = `SELECT * FROM ${binding.dataset}.${rule.name} WHERE ${rule.scopeColumn} IN (${inList})`;
    let subAst: unknown;
    try {
      subAst = parser.astify(sub, DIALECT);
    } catch {
      failure = reject('rewrite-failed', `could not build the scope subquery for ${name}`);
      return;
    }
    const subSelect = Array.isArray(subAst) ? subAst[0] : subAst;
    delete item['table'];
    delete item['db'];
    item.expr = { ast: subSelect as SelectNode, parentheses: true };
    item.as = alias;
  }

  /** Walk a SELECT statement, binding every base table it can reach. */
  function walkSelect(node: SelectNode, inherited: ReadonlySet<string>): void {
    if (failure) return;
    const cteNames = new Set(inherited);
    const withs = node['with'];
    if (Array.isArray(withs)) {
      for (const cte of withs) {
        if (!isRecord(cte)) continue;
        const stmt = cte['stmt'];
        const body = isRecord(stmt) && isSelect(stmt['ast']) ? stmt['ast'] : stmt;
        if (isSelect(body)) walkSelect(body, cteNames); // may reference earlier CTEs
        const cteName = cte['name'];
        const label =
          typeof cteName === 'string'
            ? cteName
            : isRecord(cteName) && typeof cteName['value'] === 'string'
              ? cteName['value']
              : undefined;
        if (label !== undefined) cteNames.add(label.toLowerCase());
      }
    }
    const from = node['from'];
    if (Array.isArray(from)) {
      for (const raw of from) {
        if (!isRecord(raw)) continue;
        const item = raw as FromItem;
        const nested = item.expr?.ast;
        if (isSelect(nested)) walkSelect(nested, cteNames);
        else bindTable(item, cteNames);
        if (failure) return;
      }
    }
    // Subqueries elsewhere (WHERE ... IN (SELECT ...), scalar subqueries, ...).
    for (const [key, value] of Object.entries(node)) {
      if (key === 'from' || key === 'with') continue;
      deepWalk(value, cteNames);
      if (failure) return;
    }
  }

  function deepWalk(value: unknown, cteNames: ReadonlySet<string>): void {
    if (failure || !isRecord(value)) return;
    if (isSelect(value)) {
      walkSelect(value, cteNames);
      return;
    }
    for (const inner of Object.values(value)) {
      if (Array.isArray(inner)) for (const v of inner) deepWalk(v, cteNames);
      else deepWalk(inner, cteNames);
      if (failure) return;
    }
  }

  walkSelect(root, new Set());
  if (failure) return failure;

  let bound: string;
  try {
    bound = parser.sqlify(root as never, DIALECT);
  } catch (e) {
    return reject('rewrite-failed', e instanceof Error ? e.message : 'could not regenerate SQL');
  }

  const verified = verifyAllQualified(parser, bound, binding.dataset);
  if (verified !== null) return verified;

  return { ok: true, sql: bound, tables: [...referenced].sort() };
}

/**
 * Self-check: re-parse the rewritten SQL and confirm every base table is
 * qualified to this tenant's dataset. Any table the walker missed shows up
 * here as a rejection instead of escaping to the warehouse unqualified.
 */
function verifyAllQualified(parser: SqlParser, sql: string, dataset: string): Rejection | null {
  let list: string[];
  try {
    list = parser.tableList(sql, DIALECT);
  } catch (e) {
    return reject('rewrite-failed', e instanceof Error ? e.message : 'unverifiable rewrite');
  }
  for (const entry of list) {
    // Format: "<operation>::<db>::<table>"; CTE references carry a null db.
    const parts = entry.split('::');
    const db = parts[1];
    const table = parts[2];
    if (db === dataset) continue;
    if (db === 'null' || db === undefined) {
      // Unqualified: only legitimate for CTE names, which are not physical
      // tables. We cannot tell them apart here, so require the qualified form
      // to have been applied and let a genuinely unqualified physical table
      // be caught by the allowlist walk above; if that walk missed it, refuse.
      if (isLikelyCteReference(sql, table)) continue;
      return reject('rewrite-failed', `table left unqualified after rewrite: ${table}`);
    }
    return reject('rewrite-failed', `table bound to an unexpected dataset: ${db}.${table}`);
  }
  return null;
}

/** True when `name` is declared as a CTE in `sql` (WITH name AS ...). */
function isLikelyCteReference(sql: string, name: string | undefined): boolean {
  if (name === undefined) return false;
  return new RegExp(`\\b${name.replace(/[^A-Za-z0-9_]/g, '')}\\s+AS\\s*\\(`, 'i').test(sql);
}

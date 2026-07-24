// AST-level tenant-boundary binding (ADR-0005 原則C-2). The boundary is
// compiled INTO the query, never appended as text: every physical table is
// rewritten to the tenant's own dataset, and every row-scoped table is wrapped
// in a filtering subquery at the point of use — so joins, CTEs and nested
// subqueries all carry the boundary.
//
// Fail-closed by construction: after rewriting we re-parse the output and
// assert two things independently of the walker that produced it —
//   ① every remaining base table is qualified to this tenant's dataset, and
//   ② every row-scoped table sits inside this principal's scope filter.
// A gap in the walker therefore yields a rejection, never a leak (the same
// belt-and-suspenders idea as the gate's payload tenant assert, 原則C-4).
// The ② check is what ADR-0010 / LOG-0040 found missing: unlike ①, the row
// scope has no data-layer backstop, so this self-check is all that stands
// behind it.
// node-sql-parser ships CommonJS, so the ESM loader cannot see its named
// exports — take the default and destructure.
import sqlParser from 'node-sql-parser';
import type {
  BoundQuery,
  DataScope,
  QueryPolicy,
  Rejection,
  TableRule,
  TenantBinding,
} from './types.ts';
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

  const compiled = compileRules(policy);
  if ('ok' in compiled) return compiled;
  const rules = compiled;

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

    const rowScoped = rule.scopeColumn !== null && binding.scope.kind === 'stores';
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
        const label = cteLabelOf(cte['name']);
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

  const scoped = verifyRowScope(parser, bound, binding.scope, rules);
  if (scoped !== null) return scoped;

  return { ok: true, sql: bound, tables: [...referenced].sort() };
}

/**
 * Index the allowlist by table name, refusing a policy that leaves a table's
 * row-scope status undeclared. Absence is not "no row scope" — it is
 * indistinguishable from a forgotten column, and treating it as unscoped would
 * return every row. `null` is how a dimension table says so out loud
 * (ADR-0010 D6: a control that needs remembering must fail closed).
 */
function compileRules(policy: QueryPolicy): Map<string, TableRule> | Rejection {
  const rules = new Map<string, TableRule>();
  for (const t of policy.tables) {
    if (!SAFE_IDENT.test(t.name)) return reject('rewrite-failed', `unsafe table name: ${t.name}`);
    if (t.scopeColumn === undefined)
      return reject('policy-incomplete', `table declares no scopeColumn (use null): ${t.name}`);
    if (t.scopeColumn !== null && !SAFE_IDENT.test(t.scopeColumn))
      return reject('rewrite-failed', `unsafe scope column: ${t.scopeColumn}`);
    rules.set(t.name.toLowerCase(), t);
  }
  return rules;
}

/**
 * Verify that `sql` binds the row scope at every use of a row-scoped table.
 * `bindQuery` runs this on its own output; exported because the invariant is
 * meaningful for any SQL, and because proving that it *rejects* requires
 * feeding it SQL no correct binder would produce.
 */
export function assertRowScopeBound(
  sql: string,
  scope: DataScope,
  policy: QueryPolicy,
): Rejection | null {
  const compiled = compileRules(policy);
  if ('ok' in compiled) return compiled;
  return verifyRowScope(new Parser(), sql, scope, compiled);
}

/** The name a CTE is declared under, in either shape node-sql-parser emits. */
function cteLabelOf(cteName: unknown): string | undefined {
  if (typeof cteName === 'string') return cteName;
  if (isRecord(cteName) && typeof cteName['value'] === 'string') return cteName['value'];
  return undefined;
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

/**
 * Self-check for the ② row scope, symmetric to verifyAllQualified's ① check:
 * re-parse the rewritten SQL and confirm that every row-scoped table sits
 * inside a subquery whose WHERE is exactly this principal's scope filter. A
 * table the walker failed to wrap surfaces here as a rejection instead of as
 * extra rows in the response.
 *
 * This does NOT catch a table the policy never declared as row-scoped — the
 * check reads the same policy the walker did, so it cannot detect that policy
 * being wrong. That omission is made impossible upstream instead, by requiring
 * `scopeColumn` to be declared (null for "not row-scoped"). The two together
 * are what ADR-0010 adopts; neither alone is sufficient.
 */
function verifyRowScope(
  parser: SqlParser,
  sql: string,
  scope: DataScope,
  rules: ReadonlyMap<string, TableRule>,
): Rejection | null {
  if (scope.kind !== 'stores') return null; // nothing was wrapped, nothing to verify
  const expected = [...scope.storeIds].sort().join(' ');

  let ast: unknown;
  try {
    ast = parser.astify(sql, DIALECT);
  } catch (e) {
    return reject('rewrite-failed', e instanceof Error ? e.message : 'unverifiable rewrite');
  }
  const root = Array.isArray(ast) ? ast[0] : ast;
  if (!isSelect(root)) return reject('rewrite-failed', 'rewritten SQL is no longer a SELECT');

  let failure: Rejection | null = null;

  /** A base table in `enclosing`'s FROM must carry its scope filter there. */
  function checkTable(item: FromItem, enclosing: SelectNode, cteNames: ReadonlySet<string>): void {
    const name = item.table;
    if (name === undefined || cteNames.has(name.toLowerCase())) return;
    const rule = rules.get(name.toLowerCase());
    if (rule === undefined || rule.scopeColumn === null) return;
    if (scopeFilterOf(enclosing['where'], rule.scopeColumn) !== expected)
      failure = reject('rewrite-failed', `row scope not bound at every use of ${name}`);
  }

  function checkSelect(node: SelectNode, inherited: ReadonlySet<string>): void {
    if (failure) return;
    const cteNames = new Set(inherited);
    const withs = node['with'];
    if (Array.isArray(withs)) {
      for (const cte of withs) {
        if (!isRecord(cte)) continue;
        const stmt = cte['stmt'];
        const body = isRecord(stmt) && isSelect(stmt['ast']) ? stmt['ast'] : stmt;
        if (isSelect(body)) checkSelect(body, cteNames);
        const label = cteLabelOf(cte['name']);
        if (label !== undefined) cteNames.add(label.toLowerCase());
      }
    }
    const from = node['from'];
    if (Array.isArray(from)) {
      for (const raw of from) {
        if (!isRecord(raw)) continue;
        const item = raw as FromItem;
        const nested = item.expr?.ast;
        if (isSelect(nested)) checkSelect(nested, cteNames);
        else checkTable(item, node, cteNames);
        if (failure) return;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'from' || key === 'with') continue;
      deepCheck(value, cteNames);
      if (failure) return;
    }
  }

  function deepCheck(value: unknown, cteNames: ReadonlySet<string>): void {
    if (failure || !isRecord(value)) return;
    if (isSelect(value)) {
      checkSelect(value, cteNames);
      return;
    }
    for (const inner of Object.values(value)) {
      if (Array.isArray(inner)) for (const v of inner) deepCheck(v, cteNames);
      else deepCheck(inner, cteNames);
      if (failure) return;
    }
  }

  checkSelect(root, new Set());
  return failure;
}

/**
 * The scope values a `WHERE <column> IN (...)` binds, canonicalized for
 * comparison — or null when `where` is not exactly that filter on `column`.
 * Deliberately strict: it recognizes only the shape bindTable emits, so a
 * change there fails this check loudly instead of weakening it silently.
 */
function scopeFilterOf(where: unknown, column: string): string | null {
  if (!isRecord(where) || where['type'] !== 'binary_expr' || where['operator'] !== 'IN')
    return null;
  if (columnNameOf(where['left']) !== column) return null;
  const right = where['right'];
  if (!isRecord(right) || right['type'] !== 'expr_list' || !Array.isArray(right['value']))
    return null;
  const values: string[] = [];
  for (const v of right['value']) {
    if (!isRecord(v)) return null;
    if (v['value'] === null) continue; // IN (NULL) — the empty-scope form, matches nothing
    if (typeof v['value'] !== 'string') return null;
    values.push(v['value']);
  }
  return values.sort().join(' ');
}

/** The column a column_ref names, in either shape node-sql-parser emits. */
function columnNameOf(node: unknown): string | null {
  if (!isRecord(node) || node['type'] !== 'column_ref') return null;
  const col = node['column'];
  if (typeof col === 'string') return col;
  if (isRecord(col)) {
    const expr = col['expr'];
    if (isRecord(expr) && typeof expr['value'] === 'string') return expr['value'];
  }
  return null;
}

/** True when `name` is declared as a CTE in `sql` (WITH name AS ...). */
function isLikelyCteReference(sql: string, name: string | undefined): boolean {
  if (name === undefined) return false;
  return new RegExp(`\\b${name.replace(/[^A-Za-z0-9_]/g, '')}\\s+AS\\s*\\(`, 'i').test(sql);
}

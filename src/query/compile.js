import { literalRuns, trigrams, wildcardToRegExp } from '../format.js';

export class QueryError extends Error {
  // Without this, `name` is inherited as 'Error' and every caller that routes a
  // bad query to HTTP 400 silently returns 500 instead.
  constructor(message) { super(message); this.name = 'QueryError'; }
}

const ALL = { op: 'all' };
const NONE = { op: 'none' };

export function compile(query, catalog) {
  if (query === undefined || query === null) return ALL;
  const keys = Object.keys(query);
  if (keys.length === 0) return ALL;
  if (keys.length !== 1) throw new QueryError(`expected a single query clause, got [${keys.join(', ')}]`);
  const [type] = keys;
  const body = query[type];

  switch (type) {
    case 'match_all':  return ALL;
    case 'match_none': return NONE;
    case 'term':       return compileTerm(body, catalog);
    case 'terms':      return compileTerms(body, catalog);
    case 'exists':     return compileExists(body, catalog);
    case 'range':      return compileRange(body, catalog);
    case 'prefix':     return compilePrefix(body, catalog);
    case 'wildcard':   return compileWildcard(body, catalog);
    case 'bool':       return compileBool(body, catalog);
    default:
      throw new QueryError(`unsupported query type [${type}]`);
  }
}

const meta = (f, cat) => cat.fields[f];

function unwrap(raw) {
  return raw !== null && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
}

/**
 * L1 (docs/l1-malli.md §5): with a delta applied, a single-field leaf becomes
 *   leaf(base) ANDNOT dirty(field)  OR  scan(overlay docs dirty in field).
 * `test` is the same predicate over one value. It must agree with what the base
 * structures answer for that value, which the differential tests check.
 * Fields unknown to the base stay unknown: the type is frozen in the base.
 */
function wrap(cat, field, node, test) {
  if (!cat._overlay) return node;
  return { op: 'overlay', field, inner: node, test };
}

const present = v => v !== undefined && v !== null;

function compileTerm(body, cat) {
  const [field] = Object.keys(body);
  const value = unwrap(body[field]);
  const m = meta(field, cat);
  if (!m) return NONE;
  switch (m.type) {
    case 'boolean': {
      const node = boolNode(field, value, m);
      const want = value === true || value === 'true';
      return wrap(cat, field, node, v => v === want);
    }
    case 'numeric': {
      const v = toNumber(value, field);
      return wrap(cat, field, columnNode(field, m, cat, v, v, true, true),
                  x => typeof x === 'number' && x === v);
    }
    case 'keyword': {
      const e = m.values[String(value)];
      const s = String(value);
      return wrap(cat, field, e ? { op: 'section', name: e.section } : NONE,
                  x => present(x) && String(x) === s);
    }
    case 'text': return textNode(cat, field, m, String(value));
    default: return NONE;
  }
}

function textNode(cat, field, m, pattern) {
  const re = wildcardToRegExp(pattern);
  return wrap(cat, field, wildcardNode(field, m, pattern), x => present(x) && re.test(String(x)));
}

function compileTerms(body, cat) {
  const [field] = Object.keys(body);
  const values = body[field];
  if (!Array.isArray(values)) throw new QueryError(`terms[${field}] expects an array`);
  if (values.length === 0) return NONE;
  return { op: 'or', children: values.map(v => compileTerm({ [field]: v }, cat)) };
}

function compileExists(body, cat) {
  const m = meta(body.field, cat);
  if (!m) return NONE;
  return wrap(cat, body.field, { op: 'section', name: m.sections.exists }, present);
}

function boolNode(field, value, m) {
  const v = typeof value === 'boolean' ? value
    : value === 'true' ? true : value === 'false' ? false : null;
  if (v === null) throw new QueryError(`field [${field}] is boolean; got [${JSON.stringify(value)}]`);
  return v ? { op: 'section', name: m.sections.true }
           : { op: 'andNot', left: { op: 'section', name: m.sections.exists },
                             right: { op: 'section', name: m.sections.true } };
}

function toNumber(v, field) {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
    const t = Date.parse(v);                       // ISO dates normalise to epoch ms
    if (!Number.isNaN(t)) return t;
  }
  throw new QueryError(`field [${field}] is numeric; cannot interpret [${JSON.stringify(v)}]`);
}

function compileRange(body, cat) {
  const [field] = Object.keys(body);
  const spec = body[field];
  const m = meta(field, cat);
  if (!m) return NONE;
  if (m.type !== 'numeric') throw new QueryError(`range on [${field}] requires a numeric column; it is [${m.type}]`);
  let lo = -Infinity, hi = Infinity, loInc = true, hiInc = true;
  if (spec.gte !== undefined) { lo = toNumber(spec.gte, field); loInc = true; }
  if (spec.gt  !== undefined) { lo = toNumber(spec.gt, field);  loInc = false; }
  if (spec.lte !== undefined) { hi = toNumber(spec.lte, field); hiInc = true; }
  if (spec.lt  !== undefined) { hi = toNumber(spec.lt, field);  hiInc = false; }
  return wrap(cat, field, columnNode(field, m, cat, lo, hi, loInc, hiInc), x =>
    typeof x === 'number' && (loInc ? x >= lo : x > lo) && (hiInc ? x <= hi : x < hi));
}

/** A numeric range. Byte ranges come from the resident sparse index (§12.8). */
function columnNode(field, m, cat, lo, hi, loInc, hiInc) {
  if (lo > hi) return NONE;
  return {
    op: 'column', field, lo, hi, loInc, hiInc,
    clustering: !!m.clustering,
  };
}

function compilePrefix(body, cat) {
  const [field] = Object.keys(body);
  const value = String(unwrap(body[field]));
  const m = meta(field, cat);
  if (!m) return NONE;
  if (m.type === 'keyword') {
    // Enumeration happens in the catalog — resident, so zero probes (§12.3).
    const hits = Object.entries(m.values).filter(([v]) => v.startsWith(value));
    const node = hits.length === 0 ? NONE
      : { op: 'or', children: hits.map(([, e]) => ({ op: 'section', name: e.section })) };
    return wrap(cat, field, node, x => present(x) && String(x).startsWith(value));
  }
  if (m.type === 'text') return textNode(cat, field, m, `${value}*`);
  throw new QueryError(`prefix on [${field}] requires keyword or text; it is [${m.type}]`);
}

function compileWildcard(body, cat) {
  const [field] = Object.keys(body);
  const pattern = String(unwrap(body[field]));
  const m = meta(field, cat);
  if (!m) return NONE;
  if (m.type === 'text') return textNode(cat, field, m, pattern);
  if (m.type === 'keyword') {
    const re = wildcardToRegExp(pattern);
    const hits = Object.entries(m.values).filter(([v]) => re.test(v));
    const node = hits.length === 0 ? NONE
      : { op: 'or', children: hits.map(([, e]) => ({ op: 'section', name: e.section })) };
    return wrap(cat, field, node, x => present(x) && re.test(String(x)));
  }
  throw new QueryError(`wildcard on [${field}] requires keyword or text; it is [${m.type}]`);
}

/**
 * Stage C. Literal runs of ≥3 chars narrow via trigram postings; the exact
 * pattern is then verified against the stored values. Both the postings and the
 * values section are addressable from the catalog, so they ride in one wave.
 */
function wildcardNode(field, m, pattern) {
  const runs = literalRuns(pattern);
  const grams = new Set();
  for (const r of runs) for (const g of trigrams(r)) grams.add(g);
  const usable = [...grams].filter(g => m.trigrams[g] !== undefined);
  const impossible = [...grams].some(g => m.trigrams[g] === undefined);
  if (impossible) return NONE;                 // a required trigram exists nowhere
  return { op: 'wildcard', field, pattern, grams: usable };
}

function compileBool(body, cat) {
  const arr = x => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
  const must = arr(body.must).map(q => compile(q, cat));
  const filter = arr(body.filter).map(q => compile(q, cat));
  const should = arr(body.should).map(q => compile(q, cat));
  const mustNot = arr(body.must_not).map(q => compile(q, cat));

  const conj = [...must, ...filter];
  const msm = body.minimum_should_match;
  const shouldRequired = should.length > 0 && (conj.length === 0 || (msm !== undefined && Number(msm) >= 1));
  if (shouldRequired) conj.push({ op: 'or', children: should });

  let node = conj.length === 0 ? ALL : (conj.length === 1 ? conj[0] : { op: 'and', children: conj });
  if (mustNot.length > 0) {
    node = { op: 'andNot', left: node,
             right: mustNot.length === 1 ? mustNot[0] : { op: 'or', children: mustNot } };
  }
  return node;
}

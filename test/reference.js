import { wildcardToRegExp } from '../src/format.js';

function num(v) {
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t;
}

export function refMatch(doc, query) {
  if (!query || Object.keys(query).length === 0) return true;
  const [type] = Object.keys(query);
  const body = query[type];
  const unwrap = r => (r !== null && typeof r === 'object' && 'value' in r ? r.value : r);

  switch (type) {
    case 'match_all': return true;
    case 'match_none': return false;
    case 'term': {
      const [f] = Object.keys(body);
      const v = unwrap(body[f]);
      const d = doc[f];
      if (d === undefined || d === null) return false;
      if (typeof d === 'boolean') return d === (v === true || v === 'true');
      if (typeof d === 'number') return d === num(v);
      return String(d) === String(v);
    }
    case 'terms': {
      const [f] = Object.keys(body);
      return body[f].some(v => refMatch(doc, { term: { [f]: v } }));
    }
    case 'exists': return doc[body.field] !== undefined && doc[body.field] !== null;
    case 'range': {
      const [f] = Object.keys(body);
      const s = body[f], d = doc[f];
      if (d === undefined || d === null || typeof d !== 'number') return false;
      if (s.gte !== undefined && !(d >= num(s.gte))) return false;
      if (s.gt  !== undefined && !(d >  num(s.gt)))  return false;
      if (s.lte !== undefined && !(d <= num(s.lte))) return false;
      if (s.lt  !== undefined && !(d <  num(s.lt)))  return false;
      return true;
    }
    case 'prefix': {
      const [f] = Object.keys(body);
      const d = doc[f];
      return d !== undefined && d !== null && String(d).startsWith(String(unwrap(body[f])));
    }
    case 'wildcard': {
      const [f] = Object.keys(body);
      const d = doc[f];
      return d !== undefined && d !== null && wildcardToRegExp(String(unwrap(body[f]))).test(String(d));
    }
    case 'bool': {
      const arr = x => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
      const must = arr(body.must), filter = arr(body.filter);
      const should = arr(body.should), mustNot = arr(body.must_not);
      const conj = [...must, ...filter];
      if (!conj.every(q => refMatch(doc, q))) return false;
      const msm = body.minimum_should_match;
      const req = should.length > 0 && (conj.length === 0 || (msm !== undefined && Number(msm) >= 1));
      if (req && !should.some(q => refMatch(doc, q))) return false;
      if (mustNot.some(q => refMatch(doc, q))) return false;
      return true;
    }
    default: throw new Error(`reference: unsupported ${type}`);
  }
}

export function refSearch(docs, query, { sortField = 'createdAt', order = 'asc' } = {}) {
  const hit = docs.filter(d => refMatch(d, query));
  // Mirror the index's tie-break: value, then document ID (clustering order).
  const byClustering = [...docs].sort((a, b) =>
    a.createdAt === b.createdAt ? String(a.id).localeCompare(String(b.id)) : a.createdAt - b.createdAt);
  const docIdOf = new Map(byClustering.map((d, i) => [d.id, i]));
  const sorted = hit.sort((a, b) => {
    const av = a[sortField], bv = b[sortField];
    if (av === bv) return docIdOf.get(a.id) - docIdOf.get(b.id);
    return av < bv ? -1 : 1;
  });
  return order === 'desc' ? sorted.reverse() : sorted;
}

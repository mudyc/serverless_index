import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Follow only STATIC imports — a dynamic one is a deliberate lazy edge. */
function graph(entry) {
  const seen = new Set(), bare = new Set();
  (function walk(f) {
    if (seen.has(f)) return; seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm)) {
      const spec = m[1];
      if (spec.startsWith('.')) walk(resolve(dirname(f), spec)); else bare.add(spec);
    }
  })(resolve(root, entry));
  return { files: seen, bare: [...bare] };
}

test('the core and browser entry points are runtime-neutral', () => {
  // This is the property that lets the same reader serve a Lambda and a browser.
  // It is one careless `import { readFile } from "node:fs"` away from being
  // false, and a bundler would only tell you at build time, so assert it here.
  for (const e of ['src/index.js', 'src/browser.js', 'adapters/lambda.js'])
    assert.deepEqual(graph(e).bare, [], `${e} must not import bare/builtin modules`);
});

test('the node entry point is the only one that reaches the filesystem', () => {
  const bare = graph('src/node.js').bare;
  assert.ok(bare.some(b => b.startsWith('node:')), 'node entry does use builtins');
  assert.ok(bare.every(b => b.startsWith('node:')), `unexpected deps: ${bare}`);
});

test('package exports resolve to files that exist', async () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  for (const [sub, target] of Object.entries(pkg.exports)) {
    const file = typeof target === 'string' ? target : target.default ?? target.import;
    assert.ok(readFileSync(resolve(root, file), 'utf8').length > 0, `${sub} -> ${file}`);
    await import(resolve(root, file));          // and it must actually load
  }
});

test('every entry point re-exports the budget', async () => {
  for (const e of ['src/index.js', 'src/browser.js', 'src/node.js']) {
    const m = await import(resolve(root, e));
    assert.ok(m.Budget && m.estimate, `${e} exposes the cost guard`);
  }
});

// Parse every module in the project and report syntax errors.
// Run: node tests/imports.mjs
import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { pathToFileURL } from 'url';

const root = process.cwd();
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    if (e === 'vendor' || e === 'node_modules' || e === 'serve.js') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.js')) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files.sort()) {
  const rel = relative(root, f);
  // Skip browser-only entry points that need a DOM; import the rest for real.
  const browserOnly = rel.endsWith(pathToFileURL(join('src', 'main.js')).pathname)
    || rel.includes(join('src', 'ui')) || rel.includes(join('src', 'render'))
    || rel.endsWith(join('src', 'main.js'));
  try {
    if (browserOnly) {
      // Parse only: dynamic import would need window/document.
      const src = await import('node:fs').then((fs) => fs.promises.readFile(f, 'utf8'));
      // Syntax check without executing: strip module syntax and compile the rest
      // as a function body. Good enough to catch typos in browser-only files.
      // eslint-disable-next-line no-new-func
      new Function(stripModuleSyntax(src));
    } else {
      await import(pathToFileURL(f).href);
    }
    console.log(`  ok   ${rel}`);
  } catch (e) {
    bad++;
    console.log(`  FAIL ${rel}\n       ${e.message}`);
    const line = e.stack && e.stack.match(/<anonymous>:(\d+)/);
    if (line) {
      const n = parseInt(line[1], 10);
      const src = (await import('node:fs')).readFileSync(f, 'utf8').split('\n');
      for (let i = Math.max(0, n - 3); i < Math.min(src.length, n + 2); i++) {
        console.log(`       ${i + 1}: ${src[i]}`);
      }
    }
  }
}
function stripModuleSyntax(src) {
  return src
    .replace(/^\s*import\s+[^;]*;?\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+/gm, 'const __default = ')
    .replace(/^\s*export\s+/gm, '');
}
console.log(bad ? `\n${bad} file(s) failed\n` : '\nall modules parse\n');
process.exit(bad ? 1 : 0);

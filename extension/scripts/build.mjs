import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entries = {
  background: path.join(root, 'src/background/index.ts'),
  content: path.join(root, 'src/content/index.ts'),
  panel: path.join(root, 'src/panel/panel.ts'),
};

const staticFiles = [
  ['manifest.json', 'manifest.json'],
  ['src/panel/panel.html', 'panel.html'],
  ['src/panel/panel.css', 'panel.css'],
];

async function copyStatic() {
  for (const [from, to] of staticFiles) {
    await cp(path.join(root, from), path.join(out, to));
  }
}

const options = {
  entryPoints: entries,
  bundle: true,
  format: 'iife',
  target: ['chrome114', 'safari16'],
  outdir: out,
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  legalComments: 'none',
};

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log('Watching for changes. Press Ctrl+C to stop.');
} else {
  await build(options);
  await copyStatic();
  console.log('Built extension into', out);
}

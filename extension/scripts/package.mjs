import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safari = process.argv.includes('--safari');
const dist = path.join(root, safari ? 'safari/web-extension' : 'dist');
const beta = safari || process.argv.includes('--beta');
const testOrigin = beta && new URL(process.env.BEYIM_BETA_API).hostname.endsWith('.test');
const variant = beta ? '-beta' : '';
const target = path.join(root, 'beyim-solver-' + (safari ? 'safari' : 'chrome') + variant + (testOrigin ? '-test' : '') + '.zip');

try {
  await access(path.join(dist, 'manifest.json'));
} catch {
  console.error('dist/manifest.json not found. Run "npm run build" first.');
  process.exit(1);
}

const output = createWriteStream(target);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.on('warning', (error) => {
  if (error.code === 'ENOENT') console.warn(error);
  else throw error;
});
archive.on('error', (error) => {
  throw error;
});

const done = new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
});

archive.pipe(output);
archive.directory(dist, false);
await archive.finalize();
await done;

const info = await stat(target);
console.log(`Created ${target} (${Math.round(info.size / 1024)} KB)`);

import { zipSync } from 'fflate';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safari = process.argv.includes('--safari');
const dist = path.join(root, safari ? (process.argv.includes('--server') ? 'safari/server-extension' : 'safari/web-extension') : 'dist');
const beta = (safari && process.argv.includes('--server')) || process.argv.includes('--beta');
const testOrigin = beta && new URL(process.env.BEYIM_BETA_API).hostname.endsWith('.test');
const variant = beta ? '-beta' : '';
const target = path.join(root, 'beyim-solver-' + (safari ? 'safari' : 'chrome') + variant + (testOrigin ? '-test' : '') + '.zip');

const names = (await readdir(dist)).sort();
if (!names.includes('manifest.json')) {
  throw new Error('No manifest found in ' + dist + '. Build the extension first.');
}
const files = await Promise.all(names.map(async (name) => [
  name,
  await readFile(path.join(dist, name)),
]));
const zip = zipSync(Object.fromEntries(files), { level: 9 });
await writeFile(target, zip);
console.log('Created ' + target + ' (' + Math.round(zip.length / 1024) + ' KB)');

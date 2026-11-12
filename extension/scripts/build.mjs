import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const safari = process.argv.includes('--safari');
const chromeGroq = process.argv.includes('--chrome-groq');
const directGroq = chromeGroq || (safari && !process.argv.includes('--server'));
const beta = safari || chromeGroq || process.argv.includes('--beta');
const out = path.join(root, safari ? 'safari/web-extension' : 'dist');
let betaApi = '';
if (directGroq) {
  betaApi = 'https://api.groq.com';
} else if (beta) {
  const configured = new URL(process.env.BEYIM_BETA_API ?? 'invalid');
  if (configured.protocol !== 'https:' || configured.href !== configured.origin + '/') {
    throw new Error('Set BEYIM_BETA_API to the HTTPS origin of the beta API.');
  }
  betaApi = configured.origin;
}

const entries = {
  background: path.join(root, 'src/background/index.ts'),
  content: path.join(root, 'src/content/index.ts'),
  panel: path.join(root, beta ? 'src/panel/beta.ts' : 'src/panel/panel.ts'),
};

const staticFiles = [
  [beta ? 'src/panel/beta.html' : 'src/panel/panel.html', 'panel.html'],
  [beta ? 'src/panel/beta.css' : 'src/panel/panel.css', 'panel.css'],
];

async function copyStatic() {
  const manifestFile = path.join(root, 'manifest.json');
  if (beta) {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.version = directGroq ? '0.4.3' : '0.3.0';
    manifest.description = 'Разбор упражнений Beyim с объяснением и отправкой по подтверждению.';
    manifest.permissions = ['activeTab', 'storage'];
    const apiPattern = betaApi + '/*';
    manifest.host_permissions = [...manifest.content_scripts[0].matches];
    if (safari) {
      if (directGroq) {
        manifest.host_permissions.push(apiPattern);
      } else {
        manifest.optional_host_permissions = [apiPattern];
      }
      manifest.background = { scripts: ['background.js'], persistent: false };
      manifest.action.default_popup = 'panel.html';
    } else {
      manifest.host_permissions.push(apiPattern);
      manifest.minimum_chrome_version = '120';
    }
    manifest.icons = { 128: 'icon.png' };
    manifest.action.default_icon = 'icon.png';
    await cp(path.join(root, 'src/panel/icon.png'), path.join(out, 'icon.png'));
    await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  } else {
    await cp(manifestFile, path.join(out, 'manifest.json'));
  }
  for (const [from, to] of staticFiles) {
    const source = path.join(root, from);
    const destination = path.join(out, to);
    if (safari && to === 'panel.html') {
      const html = await readFile(source, 'utf8');
      await writeFile(destination, html.replace('<html lang="ru">', '<html lang="ru" class="safari-popup">'));
    } else {
      await cp(source, destination);
    }
  }
}

const options = {
  entryPoints: entries,
  bundle: true,
  format: 'iife',
  target: safari ? ['safari18.4'] : beta ? ['chrome120'] : ['chrome114'],
  define: { BEYIM_BETA_API: JSON.stringify(betaApi), BEYIM_SAFARI: JSON.stringify(safari), BEYIM_DIRECT_GROQ: JSON.stringify(directGroq) },
  outdir: out,
  sourcemap: !beta,
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

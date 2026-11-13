import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('standalone Groq builds', () => {
  for (const [target, directory] of [
    ['firefox', 'firefox'], ['chromium', 'chromium'], ['safari', 'safari/web-extension'],
  ] as const) {
    it(`builds ${target} with the correct permissions and background`, () => {
      execFileSync(process.execPath, ['scripts/build.mjs', `--${target}`], { cwd: root, stdio: 'pipe' });
      const manifest = JSON.parse(readFileSync(resolve(root, directory, 'manifest.json'), 'utf8'));
      const panel = readFileSync(resolve(root, directory, 'panel.js'), 'utf8');
      expect(manifest.host_permissions).toContain('https://api.groq.com/*');
      expect(manifest.host_permissions).toContain('https://beyim.ai/*');
      expect(panel).toContain('https://api.groq.com');
      expect(manifest.host_permissions).not.toContain('http://localhost/*');
      if (target === 'chromium') {
        expect(manifest.background.service_worker).toBe('background.js');
      } else {
        expect(manifest.background.scripts).toContain('background.js');
      }
      if (target === 'firefox') {
        expect(manifest.browser_specific_settings.gecko.id).toBe('beyim-solver@local');
        expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required).toContain('websiteContent');
      }
      if (target === 'safari') expect(manifest.action.default_popup).toBe('panel.html');
    });
  }
});

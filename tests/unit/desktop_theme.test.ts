import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTheme } from '../../core/ui/modules/desktop-theme.js';

function fakeEnv(osDark: boolean) {
  const doc = { documentElement: { dataset: {} as Record<string, string>, style: {} as Record<string, string> } };
  const listeners: Array<() => void> = [];
  const media = {
    matches: osDark,
    addEventListener: (_: string, h: () => void) => listeners.push(h),
    removeEventListener: (_: string, h: () => void) => {
      const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1);
    }
  };
  return { doc, media, listeners, deps: { document: doc, matchMedia: () => media } };
}

test('explicit theme pins data-theme and colorScheme', () => {
  const env = fakeEnv(true);
  applyTheme('nord', env.deps as never);
  assert.equal(env.doc.documentElement.dataset.theme, 'nord');
  assert.equal(env.doc.documentElement.style.colorScheme, 'dark');
  assert.equal(env.listeners.length, 0);
});

test('light theme flips colorScheme', () => {
  const env = fakeEnv(true);
  applyTheme('light', env.deps as never);
  assert.equal(env.doc.documentElement.style.colorScheme, 'light');
});

test('system resolves from the OS and re-resolves on change', () => {
  const env = fakeEnv(true);
  applyTheme('system', env.deps as never);
  assert.equal(env.doc.documentElement.dataset.theme, 'dark');
  env.media.matches = false;
  env.listeners[0]();
  assert.equal(env.doc.documentElement.dataset.theme, 'light');
});

test('unknown value falls back to system', () => {
  const env = fakeEnv(false);
  assert.equal(applyTheme('hotdog-stand', env.deps as never), 'system');
  assert.equal(env.doc.documentElement.dataset.theme, 'light');
});

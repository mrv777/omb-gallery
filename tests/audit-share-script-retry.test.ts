import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

function scriptHarness(existing = false) {
  type Script = {
    listeners: Map<string, () => void>;
    addEventListener: (event: string, fn: () => void) => void;
    removeEventListener: (event: string) => void;
    remove: () => void;
  };
  let script: Script | null = null;
  let appended = 0;
  const create = (): Script => ({
    listeners: new Map(),
    addEventListener(event, fn) {
      this.listeners.set(event, fn);
    },
    removeEventListener(event) {
      this.listeners.delete(event);
    },
    remove() {
      script = null;
    },
  });
  if (existing) script = create();
  const source = readFileSync(
    new URL('../src/components/Slideshow/ShareDialog.tsx', import.meta.url),
    'utf8'
  );
  const js = ts.transpileModule(`${source}\nexport { loadTurnstileScript };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports: { loadTurnstileScript?: () => Promise<void> } = {};
  const window: { turnstile?: object } = {};
  runInNewContext(js, {
    exports,
    require: () => ({}),
    window,
    setTimeout,
    clearTimeout,
    document: {
      querySelector: () => script,
      createElement: create,
      head: {
        appendChild: (element: Script) => {
          script = element;
          appended++;
        },
      },
    },
  });
  return {
    load: () => exports.loadTurnstileScript!(),
    fail: () => script!.listeners.get('error')!(),
    succeed: (api = true) => {
      if (api) window.turnstile = {};
      script!.listeners.get('load')!();
    },
    appended: () => appended,
    script: () => script,
  };
}
afterEach(() => vi.useRealTimers());
describe('Turnstile script loading', () => {
  it('shares concurrent loads and inserts a fresh script after repeated failures', async () => {
    const h = scriptHarness();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pending = h.load();
      expect(h.load()).toBe(pending);
      expect(h.appended()).toBe(attempt);
      h.fail();
      await expect(pending).rejects.toThrow('turnstile-script');
      expect(h.script()).toBeNull();
    }
    const retry = h.load();
    h.succeed();
    await retry;
    await h.load();
    expect(h.appended()).toBe(4);
    expect(h.script()!.listeners.size).toBe(0);
  });
  it('removes a failed pre-existing script and retries', async () => {
    const h = scriptHarness(true);
    const first = h.load();
    h.fail();
    await expect(first).rejects.toThrow();
    const retry = h.load();
    expect(h.appended()).toBe(1);
    h.succeed();
    await retry;
  });
  it('times out a script that never emits an event and allows retry', async () => {
    vi.useFakeTimers();
    const h = scriptHarness();
    const pending = h.load();
    const rejection = expect(pending).rejects.toThrow('turnstile-script');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(h.script()).toBeNull();
    const retry = h.load();
    h.succeed();
    await retry;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a load event without the verification API', async () => {
    const h = scriptHarness();
    const pending = h.load();
    h.succeed(false);
    await expect(pending).rejects.toThrow();
    expect(h.script()).toBeNull();
  });
});

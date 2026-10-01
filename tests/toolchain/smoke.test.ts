import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/app/App';
import { inspectCoreSource } from '../../tools/check-boundaries/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const coreFixture = path.join(root, 'src/core/example.ts');

describe('live sect foundation', () => {
  it('renders a live Chinese sect interface with honest scope', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('山门长明');
    expect(html).toContain('完整玩法');
    expect(html).toContain('安排差事');
    expect(html).toContain('临时像素画面');
    expect(html).toContain('宗门库存');
    expect(html).toContain('<select');
    expect(html).toContain('<button');
    expect(html).toContain('林青');
  });

  it('can render English without changing the approved proper name', () => {
    const html = renderToStaticMarkup(createElement(App, { initialLocale: 'en' }));
    expect(html).toContain('lang="en"');
    expect(html).toContain('山门长明');
    expect(html).toContain('Playable foundation');
    expect(html).toContain('Assign a task');
    expect(html).toContain('value="en" selected');
  });

  it('keeps direct dependencies exact and the project private', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      private: boolean;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.private).toBe(true);
    for (const version of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('core boundary guard', () => {
  it('allows pure relative core and content imports', () => {
    const source = "import type { World } from './types'; import { defs } from '../content/defs'; export const next = (n: number) => n + 1;";
    expect(inspectCoreSource(source, coreFixture, root)).toEqual([]);
  });

  it('rejects engine, UI, platform and package dependencies', () => {
    for (const source of [
      "import React from 'react';",
      "import '../platform/storage';",
      "export { foo } from '../app/App';",
      "import('phaser');",
      "const fs = require('node:fs');",
    ]) {
      expect(inspectCoreSource(source, coreFixture, root).length).toBeGreaterThan(0);
    }
  });

  it('rejects non-deterministic clocks, random and execution primitives', () => {
    for (const source of ['Date.now()', 'Math.random()', "Math['random']()", 'window.setTimeout(fn)', 'eval(code)', 'new Function(code)', 'crypto.randomUUID()', 'globalThis.document', '`time: ${Date.now()}`']) {
      expect(inspectCoreSource(source, coreFixture, root).length).toBeGreaterThan(0);
    }
  });

  it('does not interpret comments and plain string/template contents as code', () => {
    const source = '// Date.now()\n/* import React from "react" */\nconst note = "Math.random()"; const template = `Date.now()`;';
    expect(inspectCoreSource(source, coreFixture, root)).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (name: string): string => readFileSync(new URL(`../../src/app/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const app = css('app.css');
const modalLock = /@supports\s+selector\(html:has\(dialog:modal\)\)\s*\{\s*html:has\(dialog:modal\)\s*\{\s*overflow:\s*hidden;\s*\}\s*\}/;

// Source contracts protect the scope of the CSS fix. They do not emulate native
// dialog state, touch scrolling, focus return or the browser's layout engine.
describe('native modal document scroll contract', () => {
  it('locks only the root while a supported native modal selector matches', () => {
    expect(app).toMatch(modalLock);
    const outsideLock = app.replace(modalLock, '');
    expect(outsideLock).not.toMatch(/(?:html|body|:root):has\([^{}]*dialog/);
    expect(app).not.toMatch(/(?:html|body|:root):has\(dialog\[open\]\)/);
  });

  it('does not permanently lock, fix or reserve a scrollbar gutter on the page', () => {
    const rootRules = [...app.matchAll(/(?:^|[{}])\s*(?:html|body|:root)\s*\{([^{}]*)\}/g)];
    expect(rootRules.length).toBeGreaterThan(0);
    for (const rule of rootRules) {
      expect(rule[1]).not.toMatch(/(?:^|;)\s*(?:overflow(?:-[xy])?|scrollbar-gutter)\s*:/);
      expect(rule[1]).not.toMatch(/(?:^|;)\s*position\s*:\s*fixed\b/);
    }
  });

  it('keeps campaign entry and ordinary save dialogs bounded and internally scrollable', () => {
    const entry = css('campaign-entry.css');
    expect(entry).toMatch(/\.campaign-entry\s*\{[^}]*max-height:\s*calc\(100dvh[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain/s);
    expect(app).toMatch(/\.save-dialog\s*\{[^}]*max-height:\s*calc\(100dvh[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain/s);
  });

  it('keeps the management save body scrollable inside its fixed heading and feedback', () => {
    const management = css('management-v9-save.css');
    expect(management).toMatch(/dialog\.management-v9-save-dialog\s*\{[^}]*overflow:\s*hidden/s);
    expect(management).toMatch(/\.management-v9-save-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain/s);
    expect(management).toMatch(/\.management-v9-save-feedback\s*\{[^}]*flex:\s*0 0 auto/s);
  });
});

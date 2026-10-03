import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const battleCss = readFileSync(new URL('../../src/app/battle.css', import.meta.url), 'utf8');
const expeditionCss = readFileSync(new URL('../../src/app/expedition.css', import.meta.url), 'utf8');

// Source/palette contracts only: this reads simple declaration blocks, not a
// browser cascade. Integration still checks computed colors and actual pixels.
function declarations(css: string, selector: string): string[] {
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1]!.split(',').some(part => part.trim() === selector))
    .map(match => match[2]!);
}

function property(css: string, selector: string, name: string): string {
  const values = declarations(css, selector).flatMap(block => block.split(';'))
    .map(declaration => declaration.trim())
    .filter(declaration => declaration.startsWith(`${name}:`))
    .map(declaration => declaration.slice(name.length + 1).trim());
  const value = values.at(-1);
  if (!value) throw new Error(`Missing ${name} in ${selector}`);
  return value;
}

function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected opaque sRGB color: ${hex}`);
  const channels = [1, 3, 5].map(start => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const levels = [luminance(foreground), luminance(background)];
  return (Math.max(...levels) + 0.05) / (Math.min(...levels) + 0.05);
}

const paperHeadings = [
  '.battle-panel .battle-inspector h3',
  '.battle-panel .battle-status-list h4',
  '.battle-panel .battle-roster h3',
  '.battle-panel .battle-fields h3',
  '.battle-panel .battle-skills h3',
] as const;

describe('battle paper heading contrast contracts', () => {
  it.each(paperHeadings)('gives %s a direct scoped ink color above expedition specificity', selector => {
    // Two class selectors outrank `.expedition-panel h3` / `h4` (one class),
    // even if expedition.css is emitted after battle.css. Color only: the
    // existing responsive font sizes are not made more specific.
    expect(selector).toMatch(/^\.battle-panel \.battle-[a-z-]+ h[34]$/);
    expect(property(battleCss, selector, 'color')).toBe('var(--battle-ink)');
    expect(declarations(battleCss, selector)).toEqual([' color: var(--battle-ink); ']);
  });

  it('keeps normal-text ink contrast above 4.5 across every affected paper surface', () => {
    const ink = property(battleCss, '.battle-panel', '--battle-ink');
    const paper = property(battleCss, '.battle-panel', '--battle-paper');
    const inspector = property(battleCss, '.battle-inspector', 'background').match(/#[\da-f]{6}/gi);
    expect(inspector).toHaveLength(2);
    expect(property(battleCss, '.battle-skills', 'background')).toBe('var(--battle-paper)');
    const backgrounds = [
      ...inspector!,
      property(battleCss, '.battle-roster', 'background'),
      property(battleCss, '.battle-summons .battle-roster', 'background'),
      property(battleCss, '.battle-fields', 'background'),
      paper,
    ];
    for (const background of backgrounds) expect(contrast(ink, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('preserves light text on the dark expedition and battle surfaces', () => {
    expect(property(expeditionCss, '.expedition-panel h3', 'color')).toBe('#e4dab7');
    expect(property(expeditionCss, '.expedition-panel h4', 'color')).toBe('#e6dbb9');
    expect(property(battleCss, '.battle-outcome', 'color')).toBe('#f8e9bf');
    expect(property(battleCss, '.battle-keyboard-help', 'color')).toBe('#d6debe');
    expect(declarations(battleCss, '.expedition-panel h3')).toEqual([]);
    expect(declarations(battleCss, '.expedition-panel h4')).toEqual([]);
    expect(declarations(battleCss, '.battle-panel h3')).toEqual([]);
    expect(declarations(battleCss, '.battle-panel h4')).toEqual([]);
  });
});

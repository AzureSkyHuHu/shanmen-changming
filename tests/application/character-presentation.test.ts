import { describe, expect, it } from 'vitest';
import { disciplePresentation } from '../../src/application/character-presentation';
describe('persistent disciple art identity', () => {
  it('keeps saved faces after roster reorder, recruitment and removal of preceding dead members', () => {
    const disciple = { id: 'entity:7', presentationId: 'disciple-2' };
    for (const position of [0, 1, 3, 12, 35]) expect(disciplePresentation(disciple, position)).toEqual({ id: 'disciple-2', index: 2 });
    expect(disciplePresentation({ ...disciple, id: 'entity:80' }, 0).id).toBe('disciple-2');
  });
  it('preserves the old roster-index rendering until the v8 migration writes a presentation ID', () => {
    for (let position = 0; position < 36; position++) expect(disciplePresentation({ id: 'legacy' }, position).index).toBe(position % 4);
    expect(disciplePresentation({ id: 'legacy' }, -1)).toEqual({ id: 'disciple-0', index: 0 });
    expect(disciplePresentation({ id: 'legacy' }, NaN).index).toBe(0);
  });
  it('never builds an asset path from an unknown or injected saved string', () => {
    for (const presentationId of ['https://invalid.example/image.png', '../secret', 'disciple-99', null, 3]) {
      expect(disciplePresentation({ id: 'entity:2', presentationId }, 1)).toEqual({ id: 'disciple-1', index: 1 });
    }
  });
});

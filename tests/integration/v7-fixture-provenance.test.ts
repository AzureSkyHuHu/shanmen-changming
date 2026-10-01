import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSave, stableHash } from '../../src/core/kernel';
import provenance from './fixtures/save-v7-campaign-provenance.json';

describe('original v7 campaign migration evidence', () => {
  it.each(provenance.fixtures)('preserves $filename source bytes and accepts its original checksum', fixture => {
    const text = readFileSync(new URL(`./fixtures/${fixture.filename}`, import.meta.url), 'utf8');
    expect(Buffer.byteLength(text)).toBe(fixture.bytes);
    expect(createHash('sha256').update(text).digest('hex')).toBe(fixture.sha256);
    const source = JSON.parse(text); const { checksum, ...body } = source;
    expect(source.saveVersion).toBe(7); expect(source.simulationVersion).toBe('0.7.0');
    expect(checksum).toBe(fixture.checksum); expect(stableHash(body)).toBe(checksum);
    const parsed = parseSave(text);
    expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

// No eager core imports: every case starts a fresh graph at a different public
// entry point, including the graph that previously captured undefined as NaN.
const entries = [
  ['construction records', () => import('../../src/core/sect-expansion/construction-record-validation')],
  ['production validator', () => import('../../src/core/sect-expansion/production-validation')],
  ['research validator', () => import('../../src/core/sect-expansion/research-validation')],
  ['maintenance validator', () => import('../../src/core/sect-expansion/maintenance-validation')],
  ['World validation', () => import('../../src/core/kernel/validation')],
  ['historical identity', () => import('../../src/core/sect-expansion/history-identity')],
] as const;
const expected = {
  CONSTRUCTION_DESCRIPTOR_NODE_BOUND: 7630017,
  CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND: 7630401,
  SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND: 14897361,
  SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND: 14898129,
  SECT_RESEARCH_DESCRIPTOR_NODE_BOUND: 15745761,
  SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND: 15747044,
};

describe('exact descriptor bounds have acyclic eager initialization', () => {
  for (const [name, enter] of entries) it(`retains every exact cutoff when ${name} loads first`, async () => {
    vi.resetModules();
    await enter();
    const leaf = await import('../../src/core/sect-expansion/descriptor-bounds');
    const construction = await import('../../src/core/sect-expansion/construction-record-validation');
    const publicConstruction = await import('../../src/core/sect-expansion/construction-validation');
    const production = await import('../../src/core/sect-expansion/production-validation');
    const research = await import('../../src/core/sect-expansion/research-validation');
    const maintenance = await import('../../src/core/sect-expansion/maintenance-validation');
    expect({
      CONSTRUCTION_DESCRIPTOR_NODE_BOUND: construction.CONSTRUCTION_DESCRIPTOR_NODE_BOUND,
      CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND: construction.CONSTRUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND,
      SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND: production.SECT_PRODUCTION_DESCRIPTOR_NODE_BOUND,
      SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND: production.SECT_PRODUCTION_RESEARCH_DESCRIPTOR_NODE_BOUND,
      SECT_RESEARCH_DESCRIPTOR_NODE_BOUND: research.SECT_RESEARCH_DESCRIPTOR_NODE_BOUND,
      SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND: maintenance.SECT_MAINTENANCE_DESCRIPTOR_NODE_BOUND,
    }).toEqual(expected);
    expect(publicConstruction.CONSTRUCTION_DESCRIPTOR_NODE_BOUND).toBe(expected.CONSTRUCTION_DESCRIPTOR_NODE_BOUND);
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      expect(leaf[key]).toBe(expected[key]);
      expect(Number.isSafeInteger(leaf[key])).toBe(true);
      expect(leaf[key]).toBeGreaterThan(0);
    }
  });
});

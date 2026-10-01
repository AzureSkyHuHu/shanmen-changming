import { describe, expect, it } from 'vitest';
import { combatCatalog, allCombatDefinitions, treeNodes, talents, skills } from '../../src/content/definitions/index.ts';
import { combatMessageSpecifications } from '../../src/content/definitions/messages.ts';
import { combatZhCN } from '../../src/content/locales/zh-CN/combat.ts';
import { combatEn } from '../../src/content/locales/en/combat.ts';
import { validateCombatCatalog, validateCombatStructure, validateSourceOwner } from '../../src/content/schemas/index.ts';
import { validateLocales } from '../../src/i18n/validation.ts';
import { brokenFixture, brokenFixtures } from './fixtures.ts';

const locales = { 'zh-CN': combatZhCN, en: combatEn };
const validate = (value: unknown = combatCatalog) => validateCombatCatalog(value, { locales });

describe('combat authoring foundation', () => {
  it('validates the entire authored package without pretending the 48-card target is complete', () => {
    const report = validate();
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.counts).toEqual({ skills: 24, treeNodes: 36, trees: 4, talents: 12, statuses: 9, summons: 1, builds: 4 });
    expect(report.warnings.map((warning) => warning.code)).toContain('incomplete-talent-catalog');
    expect(report.warnings.map((warning) => warning.code)).toContain('execution-unverified');
  });

  it('has four active and two passive skills per school, with ultimate skills occupying active slots', () => {
    for (const school of ['sword', 'body', 'alchemy', 'talisman']) {
      const entries = skills.filter((skill) => skill.school === school);
      expect(entries.filter((skill) => skill.activation === 'active')).toHaveLength(4);
      expect(entries.filter((skill) => skill.activation === 'passive')).toHaveLength(2);
      expect(entries.filter((skill) => skill.activation === 'active' && skill.ultimate)).toHaveLength(1);
    }
  });

  it('preserves all 36 source-specified Chinese node names in stable school-qualified IDs', () => {
    const names = treeNodes.map((node) => combatZhCN[node.nameKey as keyof typeof combatZhCN]);
    expect(names).toEqual(['留痕', '养锋', '归潮', '锐意', '穿云', '贯日', '守剑', '同袍', '剑阵', '厚土', '抱岳', '磐山', '听劲', '反势', '回响', '援手', '定步', '共守', '青芽', '辨性', '共炉', '回气', '护脉', '续命', '清识', '调息', '药衡', '引弧', '感应', '雷网', '起纹', '转仪', '三曜', '纸身', '缚阵', '镇岳']);
    expect(new Set(treeNodes.map((node) => node.id)).size).toBe(36);
    expect(talents.find((talent) => talent.id === 'talent.humai')?.nameKey).not.toBe(treeNodes.find((node) => node.id === 'node.alchemy.humai')?.nameKey);
  });

  it('separates permanent nodes, run talents, encounter statuses, and timed duration', () => {
    expect(treeNodes.every((node) => node.lifecycleScope === 'character')).toBe(true);
    expect(talents.every((talent) => talent.lifecycleScope === 'run')).toBe(true);
    expect(combatCatalog.statuses.every((status) => status.lifecycleScope === 'encounter')).toBe(true);
    const source = { sourceEntityId: 'entity:1', sourceDefinitionId: 'talent.humai', sourceInstanceId: 'instance:42', lifecycleScope: 'run', duration: { kind: 'ticks', ticks: 100 }, createdSequence: 42 };
    expect(validateSourceOwner(source).valid).toBe(true);
    expect(validateSourceOwner({ ...source, sourceInstanceId: '' }).valid).toBe(false);
    expect(validateSourceOwner({ ...source, duration: { kind: 'ticks', ticks: 0 } }).valid).toBe(false);
  });

  it('keeps complete two-language names and exact parameter specifications', () => {
    const result = validateLocales(combatZhCN, combatEn, combatMessageSpecifications);
    expect(result.errors).toEqual([]);
    expect(result.missingEnglishKeys).toEqual([]);
    expect(result.checkedKeys).toBe(180);
  });

  it('allows English per-key fallback while requiring Chinese copy', () => {
    const report = validateCombatCatalog(combatCatalog, { locales: { 'zh-CN': combatZhCN, en: {} } });
    expect(report.valid).toBe(true);
    expect(report.warnings.filter((warning) => warning.code === 'english-fallback')).toHaveLength(180);
    expect(validateCombatCatalog(combatCatalog, { locales: { 'zh-CN': {}, en: combatEn } }).valid).toBe(false);
  });

  it.each(['{wrong}', '{{cost}}', '{cost.toString()}'])('rejects bad translated parameters: %s', (value) => {
    const report = validateCombatCatalog(combatCatalog, { locales: { 'zh-CN': combatZhCN, en: { ...combatEn, 'combat.skill.liuhen-jian.description': value } } });
    expect(report.errors.some((error) => error.code === 'locale-parameters')).toBe(true);
  });

  it('rejects combat locale keys without a registered definition', () => {
    expect(validateCombatCatalog(combatCatalog, { locales: { 'zh-CN': { ...combatZhCN, 'combat.orphan.name': '遗漏' }, en: combatEn } }).errors.some((error) => error.code === 'locale-unknown')).toBe(true);
  });

  it('keeps every entry explicitly unbalanced and non-playable', () => {
    expect(allCombatDefinitions(combatCatalog).every((d) => d.tuning === 'unbalanced-baseline' && d.implementation !== 'verified')).toBe(true);
    const report = validateCombatCatalog(combatCatalog, { ...{ locales }, mode: 'runtime', supportedCapabilities: [] });
    expect(report.valid).toBe(false);
    expect(report.errors.some((error) => error.code === 'runtime-blocked')).toBe(true);
    expect(report.errors.some((error) => error.code === 'unsupported-capability')).toBe(true);
  });

  it('cannot enable advanced content just by changing its authoring label', () => {
    const copy = brokenFixture(['skills', 20, 'implementation'], 'verified');
    const report = validateCombatCatalog(copy, { locales, mode: 'runtime', supportedCapabilities: ['damage', 'applyStatus'] });
    expect(report.errors.some((error) => error.path === 'skill.zhikui' && error.code === 'unsupported-capability')).toBe(true);
  });

  it.each(Object.entries(brokenFixtures))('rejects the broken %s fixture', (_name, fixture) => {
    const report = validate(fixture());
    expect(report.valid).toBe(false);
    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('reports the actual tree cycle and unreachable endpoint, not just a count mismatch', () => {
    const report = validate(brokenFixtures.treeCycle());
    expect(report.errors.some((error) => error.code === 'prerequisite-cycle')).toBe(true);
    expect(report.errors.some((error) => error.code === 'tree-prerequisite')).toBe(true);
  });

  it('rejects a run modifier that would survive the run', () => {
    const permanent = skills.find((skill) => skill.id === 'skill.jianxin')!.mechanics.onInstall;
    const report = validate(brokenFixture(['talents', 0, 'mechanics', 'onInstall'], permanent));
    expect(report.errors.some((error) => error.code === 'scope-leak')).toBe(true);
  });

  it('rejects a trigger that permits its own proc family', () => {
    const family = skills[10]!.mechanics.triggers[0]!.proc.family;
    const report = validate(brokenFixture(['skills', 10, 'mechanics', 'triggers', 0, 'proc', 'allowIndirectFamilies'], [family]));
    expect(report.errors.some((error) => error.code === 'recursive-proc')).toBe(true);
  });

  it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects nonfinite or oversized numeric content: %s', (value) => {
    expect(validate(brokenFixture(['skills', 0, 'action', 'spiritCostUnits'], value)).valid).toBe(false);
  });

  it('rejects inherited executable objects and getters without reading the getter', () => {
    let reads = 0;
    const object = { ...combatCatalog };
    Object.defineProperty(object, 'skills', { enumerable: true, get() { reads += 1; return []; } });
    expect(validateCombatStructure(object).valid).toBe(false);
    expect(reads).toBe(0);
    expect(validateCombatStructure(Object.create(combatCatalog)).valid).toBe(false);
  });

  it('rejects excessively recursive content with a bounded diagnostic', () => {
    const cycle: { kind: string; condition?: unknown } = { kind: 'not' };
    cycle.condition = cycle;
    expect(validateCombatStructure(brokenFixture(['skills', 0, 'action', 'condition'], cycle)).valid).toBe(false);
  });

  it('keeps validation read-only and survives a plain JSON round trip', () => {
    const before = JSON.stringify(combatCatalog);
    expect(validate(JSON.parse(before)).valid).toBe(true);
    expect(JSON.stringify(combatCatalog)).toBe(before);
  });
});

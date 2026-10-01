import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { combatContentTranslator } from '../../src/application/combat-content-text';
import { ApplicationSession, type DeepReadonly, type SessionProjection } from '../../src/application/session';
import { ExpeditionPanel } from '../../src/app/ExpeditionPanel';
import { BuildPanel, buildDefinitionDescription, buildDefinitionName } from '../../src/app/BuildPanel';
import { battleDefinitionName, buildBattleProjection } from '../../src/phaser/PhaserBattle';
import { LEGACY_V7_CONTENT, RELEASE_V8_CANDIDATE, contentIdentity } from '../../src/content/registry';
import { resolveBuildContentContext } from '../../src/content/registry/build-context';
import { releaseTalentRows } from '../../src/content/release';
import { createBuildFrame } from '../../src/core/builds';
import { createBuildFrameV2 } from '../../src/core/builds/v2';
import { createBattle, issueCommand, stepBattle } from '../../src/core/combat';
import { createCombatController } from '../../src/core/combat/ai';
import { canonicalStringify } from '../../src/core/kernel/serialization';
import { SAFE_TRANSLATION_MESSAGE } from '../../src/i18n';

const noop = () => undefined;
const escapedText = (text: string) => renderToStaticMarkup(<>{text}</>);

describe('selected catalog presentation paths', () => {
  it.each(['zh-CN', 'en'] as const)('uses the selected run catalog for every offered and acquired talent in %s', locale => {
    const session = new ApplicationSession();
    const beforeWorld = canonicalStringify(session.exportWorld());
    const snapshot = session.getSnapshot();
    // Presentation fixtures exercise the actual cards, not an assertion that all cards
    // are mechanically obtainable. A new World can still display a frozen old run.
    vi.spyOn(session, 'getCombatCatalog').mockReturnValue(RELEASE_V8_CANDIDATE.combat);
    const selectedRun = vi.spyOn(session, 'getRunContent');
    for (const content of [RELEASE_V8_CANDIDATE, LEGACY_V7_CONTENT]) {
      selectedRun.mockReturnValue(content);
      const text = combatContentTranslator(content.combat);
      for (let index = 0; index < content.combat.talents.length; index += 3) {
        const cards = content.combat.talents.slice(index, index + 3);
        const projection: DeepReadonly<SessionProjection> = { ...snapshot, expedition: { ...snapshot.expedition,
          phase: 'RewardPending', currentOffer: { offerId: `text-offer/${index}`, revision: 1,
            candidateDefinitionIds: cards.map(card => card.id), eligibleHolderIdsByCard: {}, remainingRerolls: 0,
            diagnostics: [], supplyFallback: [{ resourceId: 'meal', quantity: 1 }] },
          talentInstances: cards.map((card, number) => ({ instanceId: `text-talent/${number}`, definitionId: card.id,
            holderScope: card.holderScope, holderId: null, boundHolderId: null, rank: 1, acquiredRewardOrdinal: 1 })),
        } };
        const beforeProjection = canonicalStringify(projection);
        const markup = renderToStaticMarkup(<ExpeditionPanel session={session} world={projection} controller={null} locale={locale} readOnly onReturnSect={noop} />);
        expect(markup.match(/class="expedition-card"/g)).toHaveLength(cards.length);
        for (const card of cards) {
          const name = text(locale, card.nameKey);
          expect(markup).toContain(`<h4>${escapedText(name)}</h4>`);
          expect(markup).toContain(`<strong>${escapedText(name)}</strong>`);
          expect(markup).toContain(escapedText(text(locale, card.descriptionKey, card.descriptionParameters)));
        }
        expect(markup).not.toContain(SAFE_TRANSLATION_MESSAGE);
        expect(canonicalStringify(projection)).toBe(beforeProjection);
      }
    }
    expect(canonicalStringify(session.exportWorld())).toBe(beforeWorld);
    expect(session.getSnapshot()).toBe(snapshot);
  });

  it('renders all new battle definition labels from release text while legacy names remain unchanged', () => {
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const row of releaseTalentRows) {
        expect(battleDefinitionName(locale, row.definition.id, RELEASE_V8_CANDIDATE.combat)).toBe(locale === 'en' ? row.enName : row.zhName);
      }
      for (const definition of [...LEGACY_V7_CONTENT.combat.skills, ...LEGACY_V7_CONTENT.combat.statuses,
        ...LEGACY_V7_CONTENT.combat.summons, ...LEGACY_V7_CONTENT.combat.talents, ...LEGACY_V7_CONTENT.combat.treeNodes]) {
        const expected = combatContentTranslator(LEGACY_V7_CONTENT.combat)(locale, definition.nameKey);
        expect(battleDefinitionName(locale, definition.id, LEGACY_V7_CONTENT.combat)).toBe(expected);
        expect(battleDefinitionName(locale, definition.id, RELEASE_V8_CANDIDATE.combat)).toBe(expected);
      }
    }
  });

  it('changes summon text with locale without mutating either battle or catalog', () => {
    const catalog = RELEASE_V8_CANDIDATE.combat;
    const arena = { origin: { x: 0, y: 0 }, widthCells: 12, heightCells: 5, cellSizeUnits: 20, blockedCells: [] };
    const initial = createBattle(catalog, { seed: 'versioned-summon-text', arena, contentMode: 'experimental', entities: [
      { id: 'entity:1', team: 'party', position: { x: 0, y: 0 }, stats: { attack: 10, maxHealth: 100 }, skills: ['skill.zhikui'] },
      { id: 'entity:2', team: 'enemy', position: { x: 40, y: 0 }, stats: { attack: 10, maxHealth: 100 } },
    ] });
    const battle = stepBattle(issueCommand(initial, catalog, { kind: 'cast', actorId: 'entity:1', skillId: 'skill.zhikui', targetId: 'entity:1' }), catalog, 24);
    const controller = createCombatController(catalog, battle, { playerTeam: 'party', arena });
    const before = canonicalStringify({ controller, catalog });
    expect(battle.summons).toHaveLength(1);
    const zh = buildBattleProjection(controller, catalog, 'zh-CN');
    const en = buildBattleProjection(controller, catalog, 'en');
    expect(zh.find(unit => unit.kind === 'summon')?.name).toBe('纸傀替身');
    expect(en.find(unit => unit.kind === 'summon')?.name).toBe('Paper Substitute');
    expect(buildBattleProjection(controller, catalog, 'zh-CN')).toEqual(zh);
    expect(canonicalStringify({ controller, catalog })).toBe(before);
  });

  it('keeps the BuildPanel legacy helper API and both registered panel versions compatible', () => {
    const context = resolveBuildContentContext(contentIdentity(RELEASE_V8_CANDIDATE), { allowCandidate: true })!;
    const legacy = LEGACY_V7_CONTENT.combat;
    const disciples = [{ discipleId: 'entity:1', school: 'sword' as const }];
    const oldFrame = createBuildFrame({ disciples, contentMode: 'experimental' }, legacy);
    const newFrame = createBuildFrameV2({ disciples, contentMode: 'experimental' }, context);
    const before = canonicalStringify({ oldFrame, newFrame });
    for (const locale of ['zh-CN', 'en'] as const) {
      for (const definition of [...legacy.skills, ...legacy.treeNodes]) {
        expect(buildDefinitionDescription(locale, definition)).toBe(buildDefinitionDescription(locale, definition, legacy));
        expect(buildDefinitionDescription(locale, definition, context.catalog)).toBe(buildDefinitionDescription(locale, definition, legacy));
        expect(buildDefinitionName(locale, definition.id, context.catalog, context)).toBe(buildDefinitionName(locale, definition.id, legacy));
      }
      const oldMarkup = renderToStaticMarkup(<BuildPanel frame={oldFrame} catalog={legacy} discipleId="entity:1" locale={locale} readOnly onCommand={() => ({ ok: true })} />);
      const newMarkup = renderToStaticMarkup(<BuildPanel frame={newFrame} catalog={context.catalog} context={context} lifeState="alive" discipleId="entity:1" locale={locale} readOnly onCommand={() => ({ ok: true })} />);
      expect(oldMarkup).not.toContain(SAFE_TRANSLATION_MESSAGE);
      expect(newMarkup).not.toContain(SAFE_TRANSLATION_MESSAGE);
    }
    expect(canonicalStringify({ oldFrame, newFrame })).toBe(before);
  });
});

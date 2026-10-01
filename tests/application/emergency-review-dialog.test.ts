import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { EmergencyRetreatDialog, confirmEmergencyReview } from '../../src/app/EmergencyRetreatDialog';
import { createWorldV8, dispatchCommandV8, advanceTicksWithStatusV8 } from '../../src/core/kernel/v8';
import type { WorldStateV8 } from '../../src/core/world/v8-types';
import { translate, type TextKey } from '../../src/i18n';

let battle: WorldStateV8;
beforeAll(() => {
  const initial = createWorldV8('review-dialog-real-battle');
  const depart = dispatchCommandV8(initial, { commandId: 'dialog:depart', sequence: 0, issuedTick: 0, kind: 'expedition.command', payload: {
    command: { commandId: 'dialog:depart', kind: 'expedition.depart', request: { routeId: 'route.qingfeng-trial', squadIds: initial.disciples.slice(0, 2).map(actor => actor.id) } },
  } });
  expect(depart.result.status).toBe('accepted');
  const travel = advanceTicksWithStatusV8(depart.world, 1200);
  expect(travel.invariantStop).toBeNull(); expect(travel.capacityStop).toBeNull();
  const entered = dispatchCommandV8(travel.world, { commandId: 'dialog:enter', sequence: 1, issuedTick: travel.world.clock.simulationTick, kind: 'expedition.command', payload: { command: { commandId: 'dialog:enter', kind: 'expedition.continue' } } });
  expect(entered.result.status).toBe('accepted');
  const fought = advanceTicksWithStatusV8(entered.world, 17);
  expect(fought.invariantStop).toBeNull(); expect(fought.capacityStop).toBeNull(); battle = fought.world;
}, 30_000);

describe('emergency retreat confirmation markup (not browser acceptance)', () => {
  it.each(['zh-CN', 'en'] as const)('shows the actual acknowledged losses in %s without mutating the World', locale => {
    const session = new ApplicationSession(battle);
    const before = JSON.stringify(session.exportWorld());
    const review = session.prepareEmergencyRetreat()!;
    expect(review).not.toBeNull();
    const markup = renderToStaticMarkup(createElement(EmergencyRetreatDialog, { session, locale, readOnly: false }));
    expect(markup).toContain('<dialog');
    expect(markup).toContain(translate(locale, 'expedition.ui.emergencyReviewHint'));
    expect(markup).toContain(translate(locale, 'expedition.ui.emergencyAcknowledge'));
    expect(markup).toContain('type="checkbox"');
    expect(markup).not.toContain('checked=""');
    expect(markup).toContain('<button disabled="">');
    for (const injury of review.preview.losses.injuryByDisciple) {
      const name = translate(locale, session.getDiscipleNameKey(injury.discipleId)! as TextKey);
      expect(markup).toContain(translate(locale, 'expedition.ui.addedInjury', { name, amount: injury.addedInjury }));
    }
    expect(markup).not.toContain('expedition.ui.');
    expect(JSON.stringify(session.exportWorld())).toBe(before);
    expect(session.getEmergencyRetreatReview()).toBe(review);
  });
  it('rechecks a newly busy storage/modal guard without submitting the shown review', () => {
    const session = new ApplicationSession(battle); const review = session.prepareEmergencyRetreat()!;
    const before = JSON.stringify(session.exportWorld()); let busy = false;
    const guard = () => busy;
    expect(guard()).toBe(false); busy = true;
    expect(confirmEmergencyReview(session, review, true, guard)).toEqual({ ok: false, code: 'CORE_PAUSED_ERROR' });
    expect(JSON.stringify(session.exportWorld())).toBe(before);
    expect(session.getSnapshot().lastCommand).toBeNull();
    expect(session.getEmergencyRetreatReview()).toBe(review);
  });
  it('renders nothing without a held review, including after cancellation', () => {
    const session = new ApplicationSession(battle);
    const render = () => renderToStaticMarkup(createElement(EmergencyRetreatDialog, { session, locale: 'zh-CN', readOnly: false }));
    expect(render()).toBe('');
    const review = session.prepareEmergencyRetreat()!;
    expect(session.cancelEmergencyRetreat(review.reviewId)).toBe(true);
    expect(render()).toBe('');
  });
});

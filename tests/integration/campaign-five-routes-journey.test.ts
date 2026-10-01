import { describe, expect, it } from 'vitest';
import { advanceTicksWithStatusV8, createWorldV8, dispatchCommandV8, previewWorldCampaign, previewWorldExpeditionV8, projectWorldCampaign,
  createSaveEnvelopeV8, serializeSaveV8, parseSaveV8, validateWorldStateV8, type CommandV8, type WorldStateV8,
  type PlayerExpeditionCommandV8, type CampaignPlayerRequest } from '../../src/core/kernel/v8';
import { CAMPAIGN_ROUTE_IDS } from '../../src/core/campaign/types';
import { getWorldContent } from '../../src/core/world/content-access';
import type { BuildCommand } from '../../src/core/builds/types';
import { copy } from '../../src/core/expeditions/shared';
type Body<T> = T extends T ? Omit<T, 'commandId'> : never;

describe('five-route actual player journey', () => {
  it('farms and cooks, fights every registered route, spends genuine rewards and restores between departures', () => {
    let world: WorldStateV8 = createWorldV8('five-route-playable'); let serial = 1; let battles = 0;
    const tick = (count: number) => {
      const step = advanceTicksWithStatusV8(world, count);
      expect(step.invariantStop, JSON.stringify(step.invariantStop)).toBeNull(); expect(step.capacityStop).toBeNull(); world = step.world;
    };
    const send = (input: Omit<CommandV8, 'commandId' | 'sequence' | 'issuedTick'>) => {
      // Each command is assembled by its concrete helper below; the union cast
      // preserves the identical generated inner/outer command identity.
      const commandId = `five-route:${serial}`; const sequence = serial++;
      const result = dispatchCommandV8(world, { ...input, commandId, sequence, issuedTick: world.clock.simulationTick });
      expect(result.result.status, JSON.stringify({ input, result: result.result })).toBe('accepted'); world = result.world; return result.result;
    };
    const expedition = (input: Body<PlayerExpeditionCommandV8>) => send({ kind: 'expedition.command', payload: { command: { ...input, commandId: `five-route:${serial}` } as PlayerExpeditionCommandV8 } });
    const build = (input: Omit<BuildCommand, 'commandId' | 'expectedRevision'>) => send({ kind: 'build.command', payload: {
      command: { ...input, commandId: `five-route:${serial}`, expectedRevision: world.builds.revision } as BuildCommand } });
    const campaign = (request: CampaignPlayerRequest) => {
      const preview = previewWorldCampaign(world, request); expect(preview.blockers).toEqual([]);
      return send({ kind: 'campaign.command', payload: { command: { ...request, commandId: `five-route:${serial}`, expectedBasisStamp: preview.basisStamp } } });
    };
    const deliver = (recipeId: string) => {
      const workerId = world.disciples.find(actor => actor.canWork && actor.lifeState === 'alive')!.id;
      send({ kind: 'production.start', payload: { recipeId, workerId } });
      for (let guard = 0; guard < 5 && world.disciples.find(actor => actor.id === workerId)!.assignmentTransactionId; guard++) tick(600);
      expect(world.disciples.find(actor => actor.id === workerId)!.assignmentTransactionId).toBeNull();
    };
    const restore = () => {
      const parsed = parseSaveV8(serializeSaveV8(createSaveEnvelopeV8(world, { buildId: 'five-route-journey', savedAt: '2026-10-01T17:00:00Z' })));
      expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true); if (!parsed.ok) throw new Error(parsed.error.message); world = parsed.world;
    };
    for (const routeId of CAMPAIGN_ROUTE_IDS) {
      const squadIds = world.disciples.filter(actor => actor.lifeState === 'alive').slice(0, 4).map(actor => actor.id);
      const required = previewWorldExpeditionV8(world, { routeId, squadIds }).minimumSupplies[0]!.quantity;
      for (let guard = 0; world.inventory.meal.owned < required && guard < 40; guard++) {
        if (world.inventory.grain.owned < 2) deliver(world.inventory.grain.owned ? 'farm.grain' : 'gather.grain');
        else deliver('cook.meal');
      }
      expect(previewWorldExpeditionV8(world, { routeId, squadIds }).blockers, routeId).toEqual([]);
      expedition({ kind: 'expedition.depart', request: { routeId, squadIds } });
      for (let guard = 0; guard < 40 && world.expedition.run?.phase !== 'Ended'; guard++) {
        const run = world.expedition.run!;
        if (run.phase === 'InEncounter') { tick(5000); battles++; }
        else if (run.phase === 'RewardPending') {
          const offer = run.offers.find(entry => entry.offerId === run.currentOfferId)!;
          expect(offer.candidateDefinitionIds).not.toContain('talent.zoumai-chengfu');
          const definitionId = offer.candidateDefinitionIds[0];
          if (definitionId) expedition({ kind: 'expedition.choose', offerId: offer.offerId, offerRevision: offer.revision, definitionId,
            holderId: offer.eligibleHolderIdsByCard[definitionId]?.[0] ?? null });
          else expedition({ kind: 'expedition.supplies', offerId: offer.offerId, offerRevision: offer.revision });
        } else if (world.expedition.travel) tick(1200);
        else expedition({ kind: 'expedition.continue' });
      }
      expect(world.expedition.run?.settlement?.reason, routeId).toBe('victory');
      expect(world.campaign.progress.clears.some(clear => clear.routeId === routeId)).toBe(true);
      expect(world.expedition.history.filter(history => history.runId === world.expedition.run?.runId)).toHaveLength(1);
      const projection = projectWorldCampaign(world); const reward = projection.equipmentClaims.find(claim => claim.routeId === routeId);
      if (reward) {
        const preferredSchool = routeId === 'route.miasma-seal' ? 'alchemy' : routeId === 'route.thunder-seal' ? 'talisman' : 'body';
        const recipient = world.builds.disciples.find(entry => entry.school === preferredSchool)!;
        const result = campaign({ kind: 'campaign.equipment.claim', routeId, discipleId: recipient.discipleId });
        const itemId = result.campaignResult!.itemInstanceIds[0]!;
        const definition = getWorldContent(world).buildRules.equipment.find(entry => entry.id === reward.definitionId)!;
        const current = world.builds.disciples.find(entry => entry.discipleId === recipient.discipleId)!;
        build({ kind: 'loadout.set', discipleId: recipient.discipleId, loadout: { ...copy(current.loadout), equipment: { ...current.loadout.equipment, [`${definition.slot}Id`]: itemId } } } as Omit<BuildCommand, 'commandId' | 'expectedRevision'>);
      }
      for (const current of [...world.builds.disciples]) {
        if (current.allocatedNodeIds.length) continue;
        const root = getWorldContent(world).combat.treeNodes.find(node => node.school === current.school && node.prerequisites.length === 0)!;
        build({ kind: 'tree.respec', discipleId: current.discipleId, nodeIds: [root.id] } as Omit<BuildCommand, 'commandId' | 'expectedRevision'>);
      }
      expect(validateWorldStateV8(world)).toEqual([]); restore();
    }
    expect(battles).toBe(15); expect(projectWorldCampaign(world).completed).toBe(true);
    expect(world.campaign.progress.clears.map(clear => clear.routeId)).toEqual([...CAMPAIGN_ROUTE_IDS]);
    expect(world.campaign.settledRunEvidence).toHaveLength(5);
    expect(new Set(world.campaign.settledRunEvidence.map(evidence => evidence.run.runId)).size).toBe(5);
  }, 300_000);
});

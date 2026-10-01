/** Authenticated World facts only. These values are derived, never saved budget authority. */
export interface BuildHistoryObligationFacts {
  readonly historyCount: number;
  readonly maximumCommands: number;
  /** Every build identity not yet retired, including finalized deaths awaiting cleanup. */
  readonly disciples: readonly {
    readonly discipleId: string;
    readonly lifeState: 'alive' | 'pendingDeath' | 'dead';
    readonly heirId: string | null;
  }[];
  /** Known historical identities permit a dead target to resolve to the sect estate. */
  readonly retiredDiscipleIds: readonly string[];
  readonly equipment: readonly { readonly itemInstanceId: string; readonly ownerDiscipleId: string | null }[];
  /** All unsettled death estates, locked or unlocked; these committed edges override heirId. */
  readonly pendingEstates: readonly { readonly discipleId: string; readonly beneficiaryId: string | null }[];
  /** One ID per admitted teaching whose authoritative build grant has not completed. */
  readonly teachingIds: readonly string[];
  /** Deduplicated missing awards and possible target awards of accepted active breakthroughs. */
  readonly realmMilestoneIds: readonly string[];
  /** A settled run has no obligation; an active run owes exactly one multi-member unlock. */
  readonly activeRun: null | { readonly runId: string; readonly firstVictoryDiscipleIds: readonly string[] };
}

export interface BuildHistoryObligationAssessment {
  readonly historyCount: number;
  readonly maximumCommands: number;
  /** Unused ledger slots before commitments; this is not permission to spend them. */
  readonly remainingCommands: number;
  readonly reservedCommands: number;
  /** Negative when an existing/imported boundary has an unfunded commitment. */
  readonly availableCommands: number;
  readonly fits: boolean;
  readonly breakdown: {
    readonly retirements: number;
    readonly transfers: number;
    readonly teachingGrants: number;
    readonly realmAwards: number;
    readonly runUnlocks: number;
    readonly firstVictoryAwards: number;
  };
}

const MAX_COMMANDS = 1024;
const MAX_DISCIPLES = 36;
const MAX_EQUIPMENT = 512;
const MAX_SQUAD = 6;

function invalid(label: string): never { throw new TypeError(`Invalid build obligation facts: ${label}`); }
/** Inspect descriptors first: malformed input must not run a getter while being rejected. */
function record(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) invalid(label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) invalid(label);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(label);
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid(label);
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(label);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(label);
  }
  return value;
}
function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:/-]{0,119}$/.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) invalid(label);
}
function integer(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(label);
}
function identities(value: unknown, maximum: number, label: string): readonly string[] {
  const entries = array(value, maximum, label); const seen = new Set<string>();
  for (const entry of entries) {
    identity(entry, label);
    if (seen.has(entry)) invalid(`duplicate ${label}`);
    seen.add(entry);
  }
  return entries as readonly string[];
}

/**
 * Remaining build-ledger commitments, not a UTF-8/saveability proof.
 *
 * R = D + sum(item's remaining ownership-chain length) + teaching + realm + unlock + first victory.
 * D + E*D is only an upper bound on the first two terms; it must not be added again.
 * A transferred item retains the heir's later death obligation. Count each distinct
 * owner until the estate, an unavailable recipient, or a cycle closes. No identity
 * can die twice. Retiring an owner and moving its items therefore spends no more
 * rows than the reserve it releases, even if an heir remains alive/away.
 *
 * World must re-admit heir edits, estate assignments, enrollments, grants and all
 * other new commands against the complete candidate. Exact receipts precede this
 * check. Old/imported deficits return fits=false; this function neither rejects
 * an already promised release nor fabricates extra capacity to recover it.
 */
export function assessBuildHistoryObligations(input: BuildHistoryObligationFacts): BuildHistoryObligationAssessment {
  const facts = record(input, ['historyCount', 'maximumCommands', 'disciples', 'retiredDiscipleIds', 'equipment',
    'pendingEstates', 'teachingIds', 'realmMilestoneIds', 'activeRun'], 'root');
  integer(facts.maximumCommands, 1, MAX_COMMANDS, 'maximumCommands');
  integer(facts.historyCount, 0, facts.maximumCommands, 'historyCount');

  const members = new Map<string, BuildHistoryObligationFacts['disciples'][number]>();
  for (const value of array(facts.disciples, MAX_DISCIPLES, 'disciples')) {
    const member = record(value, ['discipleId', 'lifeState', 'heirId'], 'disciple');
    identity(member.discipleId, 'discipleId');
    if (members.has(member.discipleId)) invalid('duplicate discipleId');
    if (member.lifeState !== 'alive' && member.lifeState !== 'pendingDeath' && member.lifeState !== 'dead') invalid('lifeState');
    if (member.heirId !== null) {
      identity(member.heirId, 'heirId');
      if (member.heirId === member.discipleId) invalid('self heir');
    }
    members.set(member.discipleId, member as unknown as BuildHistoryObligationFacts['disciples'][number]);
  }
  const retired = new Set(identities(facts.retiredDiscipleIds, MAX_COMMANDS + MAX_DISCIPLES, 'retiredDiscipleIds'));
  for (const discipleId of retired) if (members.has(discipleId)) invalid('retired/live identity overlap');
  const requireKnown = (value: string | null, label: string): void => {
    if (value !== null && !members.has(value) && !retired.has(value)) invalid(`dangling ${label}`);
  };
  for (const member of members.values()) requireKnown(member.heirId, 'heirId');

  const estates = new Map<string, string | null>();
  for (const value of array(facts.pendingEstates, MAX_DISCIPLES, 'pendingEstates')) {
    const estate = record(value, ['discipleId', 'beneficiaryId'], 'pending estate');
    identity(estate.discipleId, 'estate discipleId');
    if (estates.has(estate.discipleId)) invalid('duplicate pending estate');
    if (members.get(estate.discipleId)?.lifeState !== 'dead') invalid('estate owner is not an unretired death');
    if (estate.beneficiaryId !== null) {
      identity(estate.beneficiaryId, 'beneficiaryId');
      if (estate.beneficiaryId === estate.discipleId) invalid('self beneficiary');
    }
    requireKnown(estate.beneficiaryId, 'beneficiaryId');
    estates.set(estate.discipleId, estate.beneficiaryId);
  }
  for (const member of members.values()) {
    if (member.lifeState === 'dead' && !estates.has(member.discipleId)) invalid('dead owner lacks pending estate');
  }

  let transfers = 0;
  const itemIds = new Set<string>();
  for (const value of array(facts.equipment, MAX_EQUIPMENT, 'equipment')) {
    const item = record(value, ['itemInstanceId', 'ownerDiscipleId'], 'equipment item');
    identity(item.itemInstanceId, 'itemInstanceId');
    if (itemIds.has(item.itemInstanceId)) invalid('duplicate itemInstanceId');
    itemIds.add(item.itemInstanceId);
    if (item.ownerDiscipleId === null) continue;
    identity(item.ownerDiscipleId, 'ownerDiscipleId');
    if (!members.has(item.ownerDiscipleId)) invalid('item owner is not an unretired disciple');
    const seen = new Set<string>();
    let owner: string | null = item.ownerDiscipleId;
    while (owner !== null && !seen.has(owner)) {
      seen.add(owner); transfers += 1;
      const member: BuildHistoryObligationFacts['disciples'][number] = members.get(owner)!;
      const beneficiary: string | null = member.lifeState === 'dead' ? estates.get(owner)! : member.heirId;
      // No relay through an already dead/pending/retired beneficiary's own heirs.
      owner = beneficiary !== null && members.get(beneficiary)?.lifeState === 'alive' ? beneficiary : null;
    }
  }

  const teachingIds = identities(facts.teachingIds, MAX_DISCIPLES, 'teachingIds');
  const realmMilestoneIds = identities(facts.realmMilestoneIds, MAX_DISCIPLES * 4, 'realmMilestoneIds');
  let firstVictoryAwards = 0;
  if (facts.activeRun !== null) {
    const run = record(facts.activeRun, ['runId', 'firstVictoryDiscipleIds'], 'activeRun');
    identity(run.runId, 'runId');
    if (members.size === 0) invalid('active run has no unretired members');
    const eligible = identities(run.firstVictoryDiscipleIds, MAX_SQUAD, 'firstVictoryDiscipleIds');
    for (const discipleId of eligible) {
      const member = members.get(discipleId);
      if (!member || member.lifeState === 'dead') invalid('ineligible first-victory disciple');
    }
    firstVictoryAwards = eligible.length;
  }
  const breakdown = Object.freeze({ retirements: members.size, transfers, teachingGrants: teachingIds.length,
    realmAwards: realmMilestoneIds.length, runUnlocks: facts.activeRun === null ? 0 : 1, firstVictoryAwards });
  const reservedCommands = Object.values(breakdown).reduce((sum, amount) => sum + amount, 0);
  integer(reservedCommands, 0, Number.MAX_SAFE_INTEGER, 'reservedCommands');
  const remainingCommands = facts.maximumCommands - facts.historyCount;
  const availableCommands = remainingCommands - reservedCommands;
  return Object.freeze({ historyCount: facts.historyCount, maximumCommands: facts.maximumCommands, remainingCommands,
    reservedCommands, availableCommands, fits: availableCommands >= 0, breakdown });
}

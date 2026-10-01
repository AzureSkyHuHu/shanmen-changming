/** Stable authored art IDs; no renderer is allowed to choose a persisted face from roster order. */
export const DISCIPLE_PRESENTATION_IDS = ['disciple-0', 'disciple-1', 'disciple-2', 'disciple-3'] as const;
export type DisciplePresentationId = typeof DISCIPLE_PRESENTATION_IDS[number];
export function disciplePresentation(disciple: { readonly id: string; readonly presentationId?: unknown }, legacyIndex: number): { id: DisciplePresentationId; index: number } {
  const savedIndex = DISCIPLE_PRESENTATION_IDS.findIndex(id => id === disciple.presentationId);
  const index = savedIndex >= 0 ? savedIndex : Number.isSafeInteger(legacyIndex) && legacyIndex >= 0 ? legacyIndex % DISCIPLE_PRESENTATION_IDS.length : 0;
  return { id: DISCIPLE_PRESENTATION_IDS[index]!, index };
}

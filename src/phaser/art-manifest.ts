/** Original project-owned native-96 pixel redraws; no remote/runtime generation. */
export const PIXEL_ART_VERSION = '96-v2';
export const CHARACTER_ART = [0, 1, 2, 3].map((index) => ({ key: `disciple-${index}`, sheet: `${import.meta.env.BASE_URL}assets/characters/disciple-${index}-sheet-${PIXEL_ART_VERSION}.png`, portrait: `${import.meta.env.BASE_URL}assets/characters/disciple-${index}-${PIXEL_ART_VERSION}.png` }));
export const BUILDING_ART = ['housing', 'forest', 'herb-garden', 'kitchen', 'workshop', 'mine', 'spirit-vein', 'storage'].map((id) => ({ id, key: `building-${id}`, url: `${import.meta.env.BASE_URL}assets/environment/${id}.png` }));
export const SCENERY_ART = ['pine', 'blossom'].map((id) => ({ key: `scenery-${id}`, url: `${import.meta.env.BASE_URL}assets/environment/${id}.png` }));
export const CHARACTER_FRAME = { width: 96, height: 96, poses: 6, directions: 3, originY: 91 / 96, worldScale: 0.86, battleScale: 2 / 3 } as const;

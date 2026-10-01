import type { ApplicationSession } from '../application/session';

/** DOM controls keep their native keys. A modal owns all shortcuts while it is open. */
export function shouldHandlePause(event: Pick<KeyboardEvent, 'code' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey' | 'target'>, modalOpen: boolean): boolean {
  if (modalOpen || event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return false;
  const target = event.target;
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button, a, summary, [role="dialog"]'))) return false;
  return true;
}

export function attachInput(session: ApplicationSession, isModalOpen: () => boolean, host: Window = window): () => void {
  const handler = (event: KeyboardEvent) => {
    if (!shouldHandlePause(event, isModalOpen())) return;
    event.preventDefault();
    session.togglePlayerPause();
  };
  host.addEventListener('keydown', handler);
  return () => host.removeEventListener('keydown', handler);
}

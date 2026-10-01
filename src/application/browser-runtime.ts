import type { ApplicationSession } from './session';

/** One frame driver per mounted application; all browser listeners have matching disposal. */
export function attachBrowserRuntime(session: ApplicationSession, host: Window = window, page: Document = document): () => void {
  let stopped = false;
  let frame = 0;
  const visibility = () => session.setForeground({ visible: page.visibilityState !== 'hidden' });
  const focus = () => session.setForeground({ focused: true });
  const blur = () => session.setForeground({ focused: false });
  const tick = (timestamp: number) => {
    if (stopped) return;
    session.frame(timestamp);
    frame = host.requestAnimationFrame(tick);
  };
  session.setForeground({ visible: page.visibilityState !== 'hidden', focused: page.hasFocus() });
  page.addEventListener('visibilitychange', visibility);
  host.addEventListener('focus', focus);
  host.addEventListener('blur', blur);
  frame = host.requestAnimationFrame(tick);
  return () => {
    stopped = true;
    host.cancelAnimationFrame(frame);
    page.removeEventListener('visibilitychange', visibility);
    host.removeEventListener('focus', focus);
    host.removeEventListener('blur', blur);
    session.resetFrameBaseline();
  };
}

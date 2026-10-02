import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { translate } from './i18n';
import './app/app.css';

function ManagementUnavailable({ failed = false }: { failed?: boolean }) {
  const key = failed ? 'managementV9.previewUnavailable' : 'managementV9.previewLocked';
  return <main className="game-shell" lang="zh-CN">
    <h1>{translate('zh-CN', 'managementV9.candidate')}</h1>
    <p>{translate('zh-CN', 'managementV9.scope')}</p>
    <p>{translate('zh-CN', key)}</p>
    <p lang="en">{translate('en', key)}</p>
  </main>;
}

/** An exact build opt-in. The disabled branch imports no candidate application,
 * creates no Session and never opens, reads, copies or migrates a save database. */
export async function managementPreviewEntry(buildFlag: unknown) {
  if (buildFlag !== '1') return null;
  const [{ ApplicationSessionV9 }, { ManagementSaveControllerV9 }, { ManagementAppV9 }] = await Promise.all([
    import('./application/session-v9'), import('./application/management-v9-save-controller'), import('./app/ManagementAppV9'),
  ]);
  return {
    App: ManagementAppV9,
    createServices() {
      const session = new ApplicationSessionV9();
      try {
        const saves = new ManagementSaveControllerV9(session);
        let disposed = false;
        return { session, saves, dispose() {
          if (disposed) return;
          disposed = true; saves.stop();
          const result = session.close();
          // A synchronous subscriber may request teardown during publication.
          // BUSY confirms no close happened; retry once outside that stack.
          if (!result.ok && result.kind === 'session-rejection' && result.code === 'BUSY') queueMicrotask(() => { session.close(); });
        } };
      } catch (error) { session.close(); throw error; }
    },
  };
}

/** Only the compiled flag drives the page. No URL/storage/runtime override. */
export async function mountManagementPreview(container: HTMLElement): Promise<() => void> {
  const root = createRoot(container);
  let disposed = false; let disposeServices = () => {};
  const stop = () => {
    if (disposed) return;
    disposed = true;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', stop);
    try { root.unmount(); } finally { disposeServices(); }
  };
  if (typeof window !== 'undefined') window.addEventListener('pagehide', stop, { once: true });
  try {
    const entry = await managementPreviewEntry(import.meta.env.VITE_ENABLE_V9_MANAGEMENT);
    if (disposed) return stop;
    if (!entry) { root.render(<ManagementUnavailable />); return stop; }
    const services = entry.createServices(); disposeServices = services.dispose;
    root.render(<StrictMode><entry.App session={services.session} saves={services.saves} /></StrictMode>);
  } catch {
    disposeServices();
    if (!disposed) root.render(<ManagementUnavailable failed />);
  }
  return stop;
}

if (typeof document !== 'undefined') {
  const container = document.getElementById('management-root');
  if (!container) throw new Error('Missing management candidate root element.');
  void mountManagementPreview(container);
}

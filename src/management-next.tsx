import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createTranslator, translate, type Locale } from './i18n';
import type { MessageSpecifications } from './i18n/types';
import './app/app.css';

/** Keep the gate's copy independent of every candidate application module. */
export const managementPreviewMessagesV10 = {
  'previewV10.title': ['v10 宗门经营测试入口', 'v10 management test entry'],
  'previewV10.scope': ['独立测试入口，尚未通过完整游戏验收。普通入口、v8 与 v9 存档保持隔离。', 'An isolated test entry that has not passed full-game acceptance. Normal, v8 and v9 saves remain separate.'],
  'previewV10.locked': ['此构建未启用 v10 预览。没有创建游戏会话或打开存档数据库。', 'This build has not enabled the v10 preview. No game session or save database was opened.'],
  'previewV10.unavailable': ['v10 预览启动失败或已停止。请重新打开页面；此提示不代表进度已保存。', 'The v10 preview failed to start or has stopped. Reopen the page; this notice does not mean progress was saved.'],
  'previewV10.noMigration': ['v9 → v10 复制转换须逐步明确选择、读取和核对；启动与回访均不会自动读取旧档。复制只写入空的 v10 位置。', 'The v9 → v10 copy flow requires explicit selection, reading and review. Startup and revisits never automatically read old saves. Copies use empty v10 slots only.'],
} as const;
export const managementPreviewMessageSpecificationsV10: MessageSpecifications = Object.fromEntries(
  Object.keys(managementPreviewMessagesV10).map(key => [key, { parameters: {} }]),
);
export function createManagementPreviewTranslatorV10(locale: Locale,
  english: Record<string, string> = Object.fromEntries(Object.entries(managementPreviewMessagesV10).map(([key, values]) => [key, values[1]]))) {
  const local = createTranslator({ specifications: managementPreviewMessageSpecificationsV10,
    baseCatalog: Object.fromEntries(Object.entries(managementPreviewMessagesV10).map(([key, values]) => [key, values[0]])), englishCatalog: english });
  return (key: keyof typeof managementPreviewMessagesV10): string => local(locale, key);
}
function ManagementUnavailableV10({ failed = false }: { failed?: boolean }) {
  const key = failed ? 'previewV10.unavailable' : 'previewV10.locked';
  const t = createManagementPreviewTranslatorV10('zh-CN');
  return <main className="game-shell" lang="zh-CN">
    <h1>{translate('zh-CN', 'app.title')}</h1><h2>{t('previewV10.title')}</h2>
    <p>{t('previewV10.scope')}</p><p>{t(key)}</p><p lang="en">{createManagementPreviewTranslatorV10('en')(key)}</p>
  </main>;
}

/** Exact build opt-in only. The disabled branch imports no candidate modules,
 * creates no Session and never opens, reads, copies or migrates any database. */
export async function managementPreviewEntryV10(buildFlag: unknown) {
  if (buildFlag !== '1') return null;
  const [{ ApplicationSessionV10 }, { ManagementSaveControllerV10 }, { createManagementStorageSlotV10 }, { ManagementAppV10 }, { ManagementCopyEntryV10 }] = await Promise.all([
    import('./application/session-v10'), import('./application/management-v10-save-controller'),
    import('./app/management-v10-storage'), import('./app/ManagementAppV10'), import('./application/management-v10-copy-entry'),
  ]);
  return {
    App: ManagementAppV10,
    createServices() {
      const session = new ApplicationSessionV10();
      try {
        // Only this fresh world is paused here. Loading/importing later preserves
        // the saved world's actual pause state through the existing controller.
        const paused = session.setPaused('player', true);
        if (!paused.ok || !session.getSnapshot().paused) throw new Error('Unable to pause the fresh v10 preview Session.');
        const saves = new ManagementSaveControllerV10(session);
        let started: Promise<void> | null = null; let disposing = false;
        let initialDisposal: Promise<void> | null = null; let disposal: Promise<void> | null = null;
        const listeners = new Set<() => void>(); let version = 0;
        const disposeInitial = (): Promise<void> => {
          if (initialDisposal) return initialDisposal;
          let resolve!: () => void; let reject!: (error: unknown) => void;
          initialDisposal = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
          void (async () => {
            try { await saves.stop(); }
            finally {
              let closed = session.close();
              if (!closed.ok && closed.kind === 'session-rejection' && closed.code === 'BUSY') {
                await Promise.resolve(); closed = session.close();
              }
              if (!closed.ok && !session.getSnapshot().closed) throw new Error('Unable to close the v10 preview Session.');
            }
          })().then(resolve, reject);
          return initialDisposal;
        };
        const withHint = (adapter: ReturnType<typeof createManagementStorageSlotV10>): typeof adapter => ({ ...adapter,
          renderBody(context) { return <><p>{createManagementPreviewTranslatorV10(context.locale)('previewV10.noMigration')}</p>{adapter.renderBody(context)}</>; },
        });
        let current = { session, saves, storage: withHint(createManagementStorageSlotV10(saves)) };
        const copy = new ManagementCopyEntryV10(session, saves, adopted => {
          if (disposing || current.session !== session) return false;
          current = { session: adopted.session, saves: adopted.saves, storage: withHint(createManagementStorageSlotV10(adopted.saves, copy)) };
          version++;
          for (const listener of [...listeners]) { try { listener(); } catch { /* Root failure owns teardown. */ } }
          // The new service already owns its target. Retire the old v10 Session
          // off its publication stack, retaining any teardown failure for dispose.
          void disposeInitial().catch(() => {}); return !disposing;
        });
        current = { session, saves, storage: withHint(createManagementStorageSlotV10(saves, copy)) };
        return {
          get session() { return current.session; }, get saves() { return current.saves; }, get storage() { return current.storage; },
          get version() { return version; }, copy,
          subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
          start(): Promise<void> {
            if (disposing) return disposal!;
            started ??= Promise.resolve().then(() => { if (!disposing) return saves.start(); });
            return started;
          },
          dispose(): Promise<void> {
            if (disposal) return disposal;
            disposing = true;
            let resolve!: () => void; let reject!: (error: unknown) => void;
            disposal = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
            // Copy invalidation must precede any asynchronous normal teardown.
            const stopCopy = copy.dispose(); const stopInitial = disposeInitial();
            void Promise.allSettled([stopCopy, stopInitial]).then(results => {
              const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
              if (failure) throw failure.reason;
            }).then(resolve, reject);
            return disposal;
          },
        };
      } catch (error) {
        // Nothing has started or subscribed during construction. The only owned
        // resource at this boundary is the freshly prepared Session.
        session.close(); throw error;
      }
    },
  };
}

/** Only the compiled flag drives this page. No URL/storage/runtime override. */
export async function mountManagementPreviewV10(container: HTMLElement): Promise<() => Promise<void>> {
  let disposed = false; let disposeServices = (): Promise<void> => Promise.resolve(); let unsubscribeServices = () => {};
  let resolveStopped!: () => void; let rejectStopped!: (reason: unknown) => void;
  const stopped = new Promise<void>((resolve, reject) => { resolveStopped = resolve; rejectStopped = reject; });
  const onPageHide = () => { void stop().catch(() => { /* Teardown failure cannot write a save or restart this page. */ }); };
  const stop = (): Promise<void> => {
    if (disposed) return stopped;
    disposed = true; unsubscribeServices();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    void (async () => { try { root.unmount(); } finally { await disposeServices(); } })().then(resolveStopped, rejectStopped);
    return stopped;
  };
  const failed = async () => {
    try { unsubscribeServices(); await disposeServices(); }
    finally { if (!disposed) root.render(<ManagementUnavailableV10 failed />); }
  };
  const root = createRoot(container, { onUncaughtError: () => { void failed().catch(() => { /* The fallback already reports failure. */ }); } });
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide, { once: true });
  try {
    const entry = await managementPreviewEntryV10(import.meta.env.VITE_ENABLE_V10_MANAGEMENT);
    if (disposed) return stop;
    if (!entry) { root.render(<ManagementUnavailableV10 />); return stop; }
    const services = entry.createServices(); disposeServices = services.dispose;
    const render = () => { if (!disposed) root.render(<StrictMode><entry.App key={services.version} session={services.session} storage={services.storage} /></StrictMode>); };
    unsubscribeServices = services.subscribe(render); render();
    await services.start();
  } catch {
    await failed();
  }
  return stop;
}

if (typeof document !== 'undefined') {
  const container = document.getElementById('management-next-root');
  if (!container) throw new Error('Missing v10 management preview root element.');
  void mountManagementPreviewV10(container);
}

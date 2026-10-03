import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ManagementCopyEntryV10, CopyReviewV10 } from '../application/management-v10-copy-entry';
import type { V9V10CopyCleanupIssue } from '../application/v9-v10-copy-coordinator';
import type { MigrationBlockV10 } from '../core/sect-expansion/upgrade-types';
import { createTranslator, type Locale, type TranslationParams } from '../i18n';
import type { MessageSpecifications } from '../i18n/types';
import type { CampaignSlotId } from '../platform/persistence/management-v10-types';
import { formatManagementSaveDateV9 } from './ManagementSavePanelV9';
import './management-v10-copy.css';

export const managementCopyMessagesV10 = {
  'copyV10.title': ['从 v9 复制到 v10', 'Copy from v9 to v10'],
  'copyV10.intro': ['只在你点击后列出旧经营存档；选择来源后仍须明确读取。复制只写入空的 v10 位置，不覆盖旧档。', 'Old management saves are listed only when you ask. Reading a selected source is a separate action. Copying writes only to an empty v10 slot and preserves old saves.'],
  'copyV10.open': ['列出 v9 来源与 v10 空位置', 'List v9 sources and v10 targets'],
  'copyV10.source': ['选择 v9 来源', 'Choose a v9 source'],
  'copyV10.placeholder': ['请选择', 'Choose a slot'],
  'copyV10.sourceSlot': ['v9 存档 {number} · 版本 {revision} · {date}', 'v9 save {number} · revision {revision} · {date}'],
  'copyV10.emptySource': ['v9 存档 {number} · 空', 'v9 save {number} · empty'],
  'copyV10.read': ['读取所选来源用于检查', 'Read selected source for review'],
  'copyV10.readHint': ['读取会在独立会话中检查已保存版本，不替换当前 v10 游戏，也不推进旧游戏。若旧页面仍持有写入权，此处只读且不能复制；本流程不强行接管。', 'Reading inspects the saved revision in a separate session, without replacing the current v10 game or advancing the old game. A source held by another page stays read-only and cannot be copied. This flow does not force takeover.'],
  'copyV10.loaded': ['已读取来源：v9 存档 {number}，版本 {revision}', 'Source read: v9 save {number}, revision {revision}'],
  'copyV10.target': ['选择空的 v10 目标', 'Choose an empty v10 target'],
  'copyV10.emptyTarget': ['v10 存档 {number} · 空', 'v10 save {number} · empty'],
  'copyV10.occupiedTarget': ['v10 存档 {number} · 已占用，版本 {revision}', 'v10 save {number} · occupied, revision {revision}'],
  'copyV10.review': ['检查复制条件', 'Review copy requirements'],
  'copyV10.reviewTitle': ['复制前核对', 'Review before copying'],
  'copyV10.route': ['v9 存档 {source} → v10 存档 {target}', 'v9 save {source} → v10 save {target}'],
  'copyV10.quiet': ['来源已通过当前安静边界检查。确认时会再次校验来源、目标与完整 v10 准入。', 'The source passed the current quiet-boundary review. Confirmation checks the source, target and full v10 admission again.'],
  'copyV10.blocked': ['暂不能复制。请在 v9 页面处理下列事项并手动保存，再重新列出、读取和检查。此处不会自动取消工作或结算。', 'Copying is blocked. Resolve the following in v9, save manually, then list, read and review again. This screen does not cancel work or settle it for you.'],
  'copyV10.backup': ['提交时会在 v10 数据库中单独保留完整 v9 来源导出原文，和目标快照一同原子写入；以后保存也不会替换该备份。旧数据库里的存档正文与版本保持不变。', 'The complete v9 source export is preserved separately in the v10 database, atomically with the target snapshot. Later saves do not replace this backup. Save text and revisions in the old database remain unchanged.'],
  'copyV10.dirty': ['成功复制后会切换当前 v10 游戏。当前尚未保存的进度将被替换；可先取消并导出。', 'A successful copy switches the current v10 game. Unsaved progress will be replaced; cancel and export first if needed.'],
  'copyV10.replaceDirty': ['我确认替换当前 v10 尚未保存的进度', 'I confirm replacing current unsaved v10 progress'],
  'copyV10.confirm': ['确认复制并进入 v10', 'Confirm copy and enter v10'],
  'copyV10.cancel': ['取消复制', 'Cancel copy'],
  'copyV10.busy': ['正在检查或复制，请稍候。取消会阻止后续绑定；已完成的写入仍会保留。', 'Review or copy is in progress. Cancellation prevents later binding; completed writes remain stored.'],
  'copyV10.stale': ['来源、当前会话或目标已变化，请重新读取和检查。', 'The source, current session or target changed. Read and review again.'],
  'copyV10.unavailable': ['旧存档或目标数据库不可用，未能完成列表。取消后可重试。', 'Source or target storage is unavailable. Listing did not finish; cancel and retry.'],
  'copyV10.source-unreadable': ['所选来源未成功读取或导出，不能复制。原存档仍保留；请在 v9 页面检查或导出原文。', 'The selected source could not be read or exported, so it cannot be copied. The original remains stored; inspect or export it from v9.'],
  'copyV10.source-readonly': ['来源处于只读保护或由其他页面持有写入权，不能复制。请正常关闭旧页面，或处理恢复保护后再试。', 'The source is protected read-only or held by another page and cannot be copied. Close the old page normally, or resolve recovery protection, then try again.'],
  'copyV10.occupied': ['目标已被占用，拒绝覆盖。请取消后重新列出并选择空位置。', 'The target is occupied. Overwrite was refused; cancel, list again and choose an empty slot.'],
  'copyV10.failed': ['本次检查、复制或接入未完成。若下方列有已写入版本，该版本仍保留，请从普通 v10 存档操作明确读取。', 'Review, copy or adoption did not finish. Any written revision listed below remains stored and can be loaded explicitly through the normal v10 save controls.'],
  'copyV10.cancelled': ['复制流程已关闭；没有撤销任何已完成的写入。', 'The copy flow is closed. Any completed write remains stored.'],
  'copyV10.cleanup': ['部分清理未能确认完成。请保留原档；不要把此结果当作可继续写入或写入已撤销。', 'Some cleanup could not be confirmed. Keep the original save; this result does not authorize further writing or mean a completed write was undone.'],
  'copyV10.cleanup.SOURCE_CLEANUP_UNCONFIRMED': ['来源退休清理未能确认，不能确认只有目标继续持有写入权', 'Source retirement cleanup is unconfirmed; exclusive target writing could not be established'],
  'copyV10.cleanup.SOURCE_PROTECTION_FAILED': ['来源只读保护未能确认生效', 'Source read-only protection could not be confirmed'],
  'copyV10.cleanup.SOURCE_HOLD_RELEASE_FAILED': ['来源的临时暂停未能确认释放', 'Release of the temporary source hold could not be confirmed'],
  'copyV10.cleanup.SOURCE_LEASE_RELEASE_FAILED': ['来源写租约释放失败', 'The source writer lease could not be released'],
  'copyV10.cleanup.TARGET_LEASE_RELEASE_FAILED': ['目标写租约释放失败', 'The target writer lease could not be released'],
  'copyV10.cleanup.TARGET_SESSION_CLOSE_FAILED': ['目标游戏会话未能确认关闭', 'Closure of the target game session could not be confirmed'],
  'copyV10.cleanup.PREPARED_DISCARD_FAILED': ['未绑定的目标准备未能确认丢弃', 'Discard of the unbound prepared target could not be confirmed'],
  'copyV10.committed': ['v10 存档 {number} 的版本 {revision} 已写入，但未接入当前游戏；来源备份仍保留。', 'Revision {revision} was written to v10 save {number}, but is not mounted in the current game. The source backup remains stored.'],
  'copyV10.mounted': ['已从 v9 副本进入 v10 存档 {number}，版本 {revision}。后续进度仍需手动保存。', 'Entered the v9 copy in v10 save {number}, revision {revision}. Further progress still requires manual saves.'],
  'copyV10.block.INVALID_SOURCE': ['来源未通过完整 v9 校验', 'The source did not pass full v9 validation'],
  'copyV10.block.UNSUPPORTED_SOURCE': ['来源版本、内容或历史尚不受支持', 'The source version, content or history is unsupported'],
  'copyV10.block.ACTIVE_WORK': ['仍有生产、施工、研究、照护或其他进行中的工作', 'Production, construction, research, care or other work is still active'],
  'copyV10.block.PLANNED_BLUEPRINT': ['仍有待处理的建筑蓝图', 'Planned building blueprints remain'],
  'copyV10.block.AUTOMATIC_WORK_ENABLED': ['自动经营仍开启', 'Automatic management is still enabled'],
  'copyV10.block.PENDING_COMMANDS': ['仍有等待处理的指令', 'Commands are still pending'],
  'copyV10.block.ACTIVE_PROGRESSION': ['仍有突破、闭关、授课或构筑锁定', 'Breakthrough, seclusion, teaching or build locks remain active'],
  'copyV10.block.PENDING_LIFECYCLE': ['弟子生命周期事项尚未处理完毕', 'Disciple lifecycle matters are unresolved'],
  'copyV10.block.UNSETTLED_ESTATE': ['遗产尚未完整结算', 'An estate remains unsettled'],
  'copyV10.block.READ_ONLY_SOURCE': ['来源只读，无法取得安全复制权', 'The read-only source cannot grant safe copy ownership'],
  'copyV10.block.CAPACITY_EXCEEDED': ['来源或目标缺少所需容量余量', 'The source or target lacks required capacity headroom'],
} as const;
type Key = keyof typeof managementCopyMessagesV10;
const integer = { type: 'number', format: 'integer' } as const; const string = { type: 'string', format: 'text' } as const;
const params: MessageSpecifications = {
  'copyV10.sourceSlot': { parameters: { number: integer, revision: integer, date: string } },
  'copyV10.emptySource': { parameters: { number: integer } }, 'copyV10.emptyTarget': { parameters: { number: integer } },
  'copyV10.occupiedTarget': { parameters: { number: integer, revision: integer } },
  'copyV10.loaded': { parameters: { number: integer, revision: integer } }, 'copyV10.route': { parameters: { source: integer, target: integer } },
  'copyV10.committed': { parameters: { number: integer, revision: integer } }, 'copyV10.mounted': { parameters: { number: integer, revision: integer } },
};
export const managementCopyMessageSpecificationsV10: MessageSpecifications = Object.fromEntries(Object.keys(managementCopyMessagesV10).map(key => [key, params[key] ?? { parameters: {} }]));
export function createManagementCopyTranslatorV10(locale: Locale, english: Record<string, string> = Object.fromEntries(Object.entries(managementCopyMessagesV10).map(([key, values]) => [key, values[1]]))) {
  const translator = createTranslator({ specifications: managementCopyMessageSpecificationsV10,
    baseCatalog: Object.fromEntries(Object.entries(managementCopyMessagesV10).map(([key, values]) => [key, values[0]])), englishCatalog: english });
  return (key: Key, parameters?: TranslationParams): string => translator(locale, key, parameters);
}
const blockKey = (code: MigrationBlockV10): Key => `copyV10.block.${code}`;
const cleanupKey = (code: V9V10CopyCleanupIssue): Key => `copyV10.cleanup.${code}`;
const number = (slot: CampaignSlotId) => Number(slot.slice(-1));
export function focusManagementCopyElementV10(node: HTMLElement | null, current: () => boolean): boolean {
  if (!node?.isConnected || !current()) return false; node.focus(); return true;
}
/** Per-controller attachment identity distinguishes StrictMode replay from an
 * actual unmount or controller replacement. */
export function createManagementCopyAttachmentV10(cancel: () => Promise<void>) {
  let generation = 0;
  return { attach() { const attached = ++generation; return () => { queueMicrotask(() => { if (generation === attached) void cancel().catch(() => {}); }); }; } };
}

export function ManagementCopyPanelV10({ controller, locale, disabled = false }: { controller: ManagementCopyEntryV10; locale: Locale; disabled?: boolean }) {
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const t = useMemo(() => createManagementCopyTranslatorV10(locale), [locale]); const id = useId();
  const pendingFocus = useRef<'source' | 'open' | null>(null);
  const [acknowledged, setAcknowledged] = useState<CopyReviewV10 | null>(null);
  const openButton = useRef<HTMLButtonElement>(null); const sourceSelect = useRef<HTMLSelectElement>(null); const reviewRegion = useRef<HTMLElement>(null);
  const mounted = useRef(false); const attachment = useMemo(() => createManagementCopyAttachmentV10(() => controller.cancel()), [controller]); const lastReview = useRef<CopyReviewV10 | null>(null);
  // StrictMode cleanup/setup replay is not an intentional dialog close. A real
  // unmount cancels on the next microtask; entry/pagehide disposal stays external.
  useEffect(() => {
    mounted.current = true; const detach = attachment.attach();
    return () => { mounted.current = false; detach(); };
  }, [attachment]);
  useEffect(() => {
    if (status.review && status.review !== lastReview.current) {
      lastReview.current = status.review; focusManagementCopyElementV10(reviewRegion.current, () => mounted.current && controller.getSnapshot().review === status.review);
    }
    if (!status.review) lastReview.current = null;
  }, [status.review]);
  useEffect(() => {
    if (status.busy) return;
    if (pendingFocus.current === 'source' && status.phase === 'selecting' && focusManagementCopyElementV10(sourceSelect.current, () => mounted.current)) pendingFocus.current = null;
    if (pendingFocus.current === 'open' && status.phase === 'idle' && focusManagementCopyElementV10(openButton.current, () => mounted.current)) pendingFocus.current = null;
  }, [status.phase, status.busy]);
  const cancel = () => {
    setAcknowledged(null); pendingFocus.current = 'open'; void controller.cancel().catch(() => {});
  };
  const review = status.review; const active = status.phase !== 'idle' && status.phase !== 'completed' && status.phase !== 'disposed';
  const current = !!review && controller.isReviewCurrent(review);
  return <section className="management-v10-copy" aria-labelledby={`${id}-title`} aria-busy={status.busy} onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !active) return;
    event.preventDefault(); event.stopPropagation(); cancel();
  }}>
    <h3 id={`${id}-title`}>{t('copyV10.title')}</h3><p>{t('copyV10.intro')}</p>
    {status.phase === 'idle' && <button ref={openButton} type="button" disabled={status.busy || disabled} onClick={() => { pendingFocus.current = 'source'; void controller.open(); }}>{t('copyV10.open')}</button>}
    {active && <>
      <label className="management-v9-field">{t('copyV10.source')}<select ref={sourceSelect} disabled={status.busy} value={status.selectedSource ?? ''} onChange={event => {
        const row = status.sources.find(row => row.slotId === event.currentTarget.value); setAcknowledged(null); controller.selectSource(row?.slotId ?? null);
      }}><option value="">{t('copyV10.placeholder')}</option>{status.sources.map(row => <option key={row.slotId} value={row.slotId} disabled={row.revision === null}>
        {row.revision === null ? t('copyV10.emptySource', { number: number(row.slotId) }) : t('copyV10.sourceSlot', { number: number(row.slotId), revision: row.revision, date: formatManagementSaveDateV9(row.savedAt, locale) })}
      </option>)}</select></label>
      <p>{t('copyV10.readHint')}</p><button type="button" disabled={status.busy || !status.selectedSource} onClick={() => { setAcknowledged(null); void controller.readSource(); }}>{t('copyV10.read')}</button>
      {status.loadedSource && <>
        <p>{t('copyV10.loaded', { number: number(status.loadedSource.slotId), revision: status.loadedSource.revision! })}</p>
        <label className="management-v9-field">{t('copyV10.target')}<select disabled={status.busy} value={status.selectedTarget ?? ''} onChange={event => {
          const row = status.targets.find(row => row.slotId === event.currentTarget.value); setAcknowledged(null); controller.selectTarget(row?.slotId ?? null);
        }}><option value="">{t('copyV10.placeholder')}</option>{status.targets.map(row => <option key={row.slotId} value={row.slotId} disabled={row.revision !== null}>
          {row.revision === null ? t('copyV10.emptyTarget', { number: number(row.slotId) }) : t('copyV10.occupiedTarget', { number: number(row.slotId), revision: row.revision })}
        </option>)}</select></label>
        <button type="button" disabled={status.busy || !status.selectedTarget} onClick={() => { setAcknowledged(null); void controller.review(); }}>{t('copyV10.review')}</button>
      </>}
      {review && <section ref={reviewRegion} className="management-v9-review" tabIndex={-1} aria-labelledby={`${id}-review`}>
        <h4 id={`${id}-review`}>{t('copyV10.reviewTitle')}</h4><p>{t('copyV10.route', { source: number(review.source.slotId), target: number(review.targetSlotId) })}</p>
        {review.blockers.length ? <><p>{t('copyV10.blocked')}</p><ul>{review.blockers.map(code => <li key={code}>{t(blockKey(code))}</li>)}</ul></> : <p>{t('copyV10.quiet')}</p>}
        <p>{t('copyV10.backup')}</p>
        {review.dirty && <><p>{t('copyV10.dirty')}</p><label className="management-v9-checkbox"><input type="checkbox" disabled={status.busy || !current || !!review.blockers.length} checked={acknowledged === review} onChange={event => setAcknowledged(event.currentTarget.checked ? review : null)} />{t('copyV10.replaceDirty')}</label></>}
        {!current && !status.busy && !review.blockers.length && <p>{t('copyV10.stale')}</p>}
        <button type="button" disabled={status.busy || !current || !!review.blockers.length || review.dirty && acknowledged !== review} onClick={() => { void controller.confirm(review, acknowledged === review); }}>{t('copyV10.confirm')}</button>
      </section>}
      <button type="button" className="secondary" onClick={cancel}>{t('copyV10.cancel')}</button>
    </>}
    <div role="status" aria-live="polite">
      {status.busy && <p>{t('copyV10.busy')}</p>}
      {status.notice && (status.notice !== 'cleanup' || !status.cleanup.length) && <p>{t(`copyV10.${status.notice}`)}</p>}
      {!!status.cleanup.length && <div><p>{t('copyV10.cleanup')}</p><ul>{status.cleanup.map(code => <li key={code}>{t(cleanupKey(code))}</li>)}</ul></div>}
      {status.committed && <p>{t(status.committed.mounted ? 'copyV10.mounted' : 'copyV10.committed', { number: number(status.committed.slotId), revision: status.committed.revision })}</p>}
    </div>
  </section>;
}

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { InventoryDiscardGuard, InventoryDiscardRequest } from '../application/inventory-contract';
import { RESOURCE_IDS, type ResourceId, type ResourceLine } from '../core/economy/types';
import type { TextKey, TranslationParams } from '../i18n';
import './inventory.css';

type Translator = (key: TextKey, parameters?: TranslationParams) => string;
export interface InventoryResource {
  readonly resourceId: ResourceId;
  readonly owned: number;
  readonly reserved: number;
  readonly available: number;
  readonly capacity: number;
}
export interface InventoryDiscardCommandResult { readonly ok: boolean; readonly code?: string }
export interface InventoryPanelProps {
  readonly resources: readonly InventoryResource[];
  readonly sessionEpoch: number;
  readonly readOnly: boolean;
  readonly busy?: boolean;
  /** Current return overflow from the actual pending settlement; suggestions never dispatch. */
  readonly suggestedDiscard?: readonly Readonly<ResourceLine>[];
  readonly t: Translator;
  /** The application must recheck the guard against current authority immediately before dispatch. */
  readonly onDiscard: (request: InventoryDiscardRequest, guard: InventoryDiscardGuard) => InventoryDiscardCommandResult;
}
export interface InventoryDiscardDraft { readonly resourceId: string; readonly quantity: string }
export interface InventoryDiscardConfirmation {
  readonly request: Readonly<InventoryDiscardRequest>;
  readonly guard: Readonly<InventoryDiscardGuard>;
}
function validStock(stock: InventoryResource | undefined): stock is InventoryResource {
  return !!stock && RESOURCE_IDS.includes(stock.resourceId)
    && [stock.owned, stock.reserved, stock.available, stock.capacity].every(value => Number.isSafeInteger(value) && value >= 0)
    && stock.reserved <= stock.owned && stock.owned <= stock.capacity && stock.available === stock.owned - stock.reserved;
}
/** Keep raw invalid edits visible; do not round, clamp, coerce exponent notation or choose a default amount. */
export function inventoryDiscardQuantity(raw: string, available: number): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const quantity = Number(raw);
  return Number.isSafeInteger(quantity) && quantity > 0 && Number.isSafeInteger(available) && quantity <= available ? quantity : null;
}
export function inventoryDiscardIsCurrent(props: Pick<InventoryPanelProps, 'resources' | 'sessionEpoch'>, confirmation: InventoryDiscardConfirmation): boolean {
  const { request, guard } = confirmation;
  const stock = props.resources.find(resource => resource.resourceId === request.resourceId);
  return validStock(stock) && guard.sessionEpoch === props.sessionEpoch && guard.resourceId === request.resourceId
    && stock.owned === guard.owned && stock.reserved === guard.reserved && stock.capacity === guard.capacity
    && Number.isSafeInteger(request.quantity) && request.quantity > 0 && request.quantity <= stock.available;
}
export function prepareInventoryDiscard(props: Pick<InventoryPanelProps, 'resources' | 'sessionEpoch' | 'readOnly' | 'busy'>, draft: InventoryDiscardDraft): InventoryDiscardConfirmation | null {
  if (props.readOnly || props.busy) return null;
  const stock = props.resources.find(resource => resource.resourceId === draft.resourceId);
  if (!validStock(stock)) return null;
  const quantity = inventoryDiscardQuantity(draft.quantity, stock.available);
  if (quantity === null) return null;
  return Object.freeze({
    request: Object.freeze({ resourceId: stock.resourceId, quantity }),
    guard: Object.freeze({ sessionEpoch: props.sessionEpoch, resourceId: stock.resourceId, owned: stock.owned, reserved: stock.reserved, capacity: stock.capacity }),
  });
}
/** A confirmation is one-use even during re-entrant or same-render clicks. No command IDs belong in UI state. */
export function createInventoryDiscardSubmitter() {
  const used = new WeakSet<InventoryDiscardConfirmation>();
  let inFlight = false;
  let awaitingProjection: InventoryDiscardConfirmation | null = null;
  const submit = (props: InventoryPanelProps, confirmation: InventoryDiscardConfirmation): InventoryDiscardCommandResult => {
    if (inFlight || used.has(confirmation)) return { ok: false, code: 'DUPLICATE_CONFIRMATION' };
    if (props.readOnly || props.busy) return { ok: false, code: 'READ_ONLY_OR_BUSY' };
    if (!inventoryDiscardIsCurrent(props, confirmation)) return { ok: false, code: 'STALE_INVENTORY' };
    if (awaitingProjection && inventoryDiscardIsCurrent(props, awaitingProjection)) return { ok: false, code: 'AWAITING_PROJECTION' };
    awaitingProjection = null;
    used.add(confirmation);
    inFlight = true;
    try {
      // Detached payloads keep callback ownership separate from the reviewed amount and stock basis.
      const result = props.onDiscard({ ...confirmation.request }, { ...confirmation.guard });
      if (result.ok) awaitingProjection = confirmation;
      return result;
    } catch {
      // A throwing callback may already have dispatched. Do not issue another debit on that basis.
      awaitingProjection = confirmation;
      return { ok: false, code: 'CALLBACK_FAILED' };
    } finally { inFlight = false; }
  };
  return Object.assign(submit, { observe(props: Pick<InventoryPanelProps, 'resources' | 'sessionEpoch'>) {
    if (awaitingProjection && !inventoryDiscardIsCurrent(props, awaitingProjection)) awaitingProjection = null;
  } });
}

/** Replacing a campaign discards every local input, confirmation, notice and duplicate-click latch. */
export function InventoryPanel(props: InventoryPanelProps) {
  return <InventoryEditor key={props.sessionEpoch} {...props} />;
}
function InventoryEditor(props: InventoryPanelProps) {
  const { resources, t, readOnly, busy = false } = props;
  const id = useId();
  const [open, setOpen] = useState(!!props.suggestedDiscard?.length);
  const suggestionStamp = JSON.stringify(props.suggestedDiscard ?? []);
  useEffect(() => { if (props.suggestedDiscard?.length) setOpen(true); }, [suggestionStamp]);
  const quantityInput = useRef<HTMLInputElement>(null);
  const restoreQuantityFocus = useRef(false);
  const submit = useRef(createInventoryDiscardSubmitter());
  const [draft, setDraft] = useState<InventoryDiscardDraft>({ resourceId: resources[0]?.resourceId ?? '', quantity: '' });
  const [confirmation, setConfirmation] = useState<InventoryDiscardConfirmation | null>(null);
  const [submission, setSubmission] = useState<InventoryDiscardConfirmation | null>(null);
  const [notice, setNotice] = useState<{ kind: 'applied' | 'rejected' | 'uncertain'; request: Readonly<InventoryDiscardRequest> } | null>(null);
  useLayoutEffect(() => {
    if (!confirmation && restoreQuantityFocus.current) { quantityInput.current?.focus(); restoreQuantityFocus.current = false; }
  }, [confirmation]);
  const selected = resources.find(resource => resource.resourceId === draft.resourceId);
  const stale = !!confirmation && !inventoryDiscardIsCurrent(props, confirmation);
  const pending = !!submission && inventoryDiscardIsCurrent(props, submission);
  useEffect(() => {
    submit.current.observe(props);
    if (submission && !pending) setSubmission(null);
  }, [resources, props.sessionEpoch, submission, pending]);
  const blocked = readOnly || busy || pending;
  const quantity = inventoryDiscardQuantity(draft.quantity, selected?.available ?? 0);
  const invalid = draft.quantity !== '' && quantity === null;
  const text = (suffix: string, parameters?: TranslationParams) => t(`inventory.${suffix}` as TextKey, parameters);
  function review() {
    if (blocked || confirmation) return;
    const prepared = prepareInventoryDiscard(props, draft);
    if (prepared) { setConfirmation(prepared); setNotice(null); }
  }
  function cancel() { restoreQuantityFocus.current = true; setConfirmation(null); }
  function confirm() {
    if (!confirmation || blocked || stale) return;
    const result = submit.current(props, confirmation);
    if (result.code === 'DUPLICATE_CONFIRMATION' || result.code === 'AWAITING_PROJECTION') return;
    if (result.ok || result.code === 'CALLBACK_FAILED') setSubmission(confirmation);
    setNotice({ kind: result.ok ? 'applied' : result.code === 'CALLBACK_FAILED' ? 'uncertain' : 'rejected', request: confirmation.request });
    setConfirmation(null);
    if (result.ok) setDraft({ resourceId: confirmation.request.resourceId, quantity: '' });
  }
  return <details className="inventory-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => event.stopPropagation()}>
    <summary>{text('title')}</summary>
    <div className="inventory-body">
      <p className="inventory-help">{text('purpose')}</p>
      {!!props.suggestedDiscard?.length && <div className="inventory-return-help"><p>{text('returnHint')}</p><ul>{props.suggestedDiscard.map(line => {
        const stock = resources.find(resource => resource.resourceId === line.resourceId);
        if (!validStock(stock) || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) return null;
        return <li key={line.resourceId}><span>{text('overflow', { name: t(`resource.${line.resourceId}`), quantity: line.quantity })}</span><button type="button" className="secondary" disabled={blocked || !!confirmation || line.quantity > stock.available} onClick={() => { setDraft({ resourceId: line.resourceId, quantity: String(line.quantity) }); setNotice(null); quantityInput.current?.focus(); }}>{text('useSuggestion')}</button></li>;
      })}</ul><p className="inventory-help">{text('returnRetry')}</p></div>}
      <ul className="inventory-stock-list" aria-label={text('stockTitle')}>{resources.map(resource => <li key={resource.resourceId}>
        <strong>{t(`resource.${resource.resourceId}`)}</strong>
        <span>{text('held', { owned: resource.owned, capacity: resource.capacity })}</span>
        <span>{text('available', { available: resource.available, reserved: resource.reserved })}</span>
      </li>)}</ul>
      <p id={`${id}-reserved`} className="inventory-help">{text('reservedHint')}</p>
      {(readOnly || busy || pending) && <p className="inventory-notice" role="status">{text(readOnly ? 'readOnly' : busy ? 'busy' : notice?.kind === 'uncertain' ? 'uncertain' : 'pending')}</p>}
      <fieldset className="inventory-fields" disabled={blocked || !!confirmation} aria-describedby={`${id}-reserved`}>
        <legend className="sr-only">{text('discardTitle')}</legend>
        <label htmlFor={`${id}-resource`}>{text('resource')}<select id={`${id}-resource`} value={draft.resourceId} disabled={blocked || !!confirmation || !resources.length} onChange={event => { setDraft({ resourceId: event.target.value, quantity: '' }); setNotice(null); }}>
          {resources.map(resource => <option key={resource.resourceId} value={resource.resourceId}>{t(`resource.${resource.resourceId}`)}</option>)}
        </select></label>
        <label htmlFor={`${id}-quantity`}>{text('quantity')}<input ref={quantityInput} id={`${id}-quantity`} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" value={draft.quantity} disabled={blocked || !!confirmation || !validStock(selected) || selected.available === 0} aria-invalid={invalid} aria-describedby={`${id}-amount-help${invalid ? ` ${id}-invalid` : ''}`} onChange={event => { setDraft({ ...draft, quantity: event.target.value }); setNotice(null); }} /></label>
        <button type="button" className="secondary inventory-review" disabled={blocked || !!confirmation || quantity === null || !validStock(selected)} onClick={review}>{text('review')}</button>
      </fieldset>
      <p id={`${id}-amount-help`} className="inventory-help">{text('quantityHint', { available: selected?.available ?? 0 })}</p>
      {invalid && <p id={`${id}-invalid`} className="inventory-notice" role="alert">{text('invalid')}</p>}
      {confirmation && <InventoryDiscardReview confirmation={confirmation} stale={stale} blocked={blocked} t={t} onConfirm={confirm} onCancel={cancel} />}
      <p className="inventory-feedback" role="status" aria-live="polite">{notice ? text(notice.kind, notice.kind === 'applied' ? { name: t(`resource.${notice.request.resourceId}`), quantity: notice.request.quantity } : undefined) : null}</p>
    </div>
  </details>;
}

export function InventoryDiscardReview({ confirmation, stale, blocked, t, onConfirm, onCancel }: {
  readonly confirmation: InventoryDiscardConfirmation; readonly stale: boolean; readonly blocked: boolean;
  readonly t: Translator; readonly onConfirm: () => void; readonly onCancel: () => void;
}) {
  const id = useId();
  const keepButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { keepButton.current?.focus(); }, [stale]);
  const text = (suffix: string, parameters?: TranslationParams) => t(`inventory.${suffix}` as TextKey, parameters);
  return <section className="inventory-confirmation" role="group" aria-labelledby={`${id}-confirm-title`}>
    <h3 id={`${id}-confirm-title`}>{text('confirmTitle')}</h3>
    <p>{text('confirm', { name: t(`resource.${confirmation.request.resourceId}`), quantity: confirmation.request.quantity })}</p>
    <p className="inventory-help">{text('confirmReserved', { reserved: confirmation.guard.reserved, remaining: confirmation.guard.owned - confirmation.request.quantity })}</p>
    {stale && <p className="inventory-notice" role="alert">{text('stale')}</p>}
    <div className="inventory-actions"><button type="button" className="inventory-confirm" disabled={blocked || stale} onClick={onConfirm}>{text('confirmButton', { name: t(`resource.${confirmation.request.resourceId}`), quantity: confirmation.request.quantity })}</button><button ref={keepButton} type="button" className="secondary" onClick={onCancel}>{text(stale ? 'reviewAgain' : 'cancel')}</button></div>
  </section>;
}

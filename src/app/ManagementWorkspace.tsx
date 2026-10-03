import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import './management-workspace.css';

export type ManagementWorkspaceSection = 'overview' | 'roster' | 'cultivation' | 'build' | 'placement' | 'production' | 'jobs' | 'research' | 'upgrade' | 'care' | 'maintenance';
export type ManagementSectSection = Extract<ManagementWorkspaceSection, 'placement' | 'production' | 'jobs' | 'research' | 'upgrade' | 'care' | 'maintenance'>;
export interface ManagementWorkspaceFocusRequest { section: ManagementWorkspaceSection; opener: HTMLElement }
/** One roster activation may move focus out of the panel it just hid. No clock,
 * map, or tab publication grants this ownership. A later interaction wins. */
export function focusManagementWorkspacePanel(request: ManagementWorkspaceFocusRequest, active: ManagementWorkspaceSection,
  panel: HTMLElement, documentPort: Pick<Document, 'activeElement' | 'body'>): boolean {
  if (request.section !== active || !panel.isConnected || !request.opener.isConnected) return false;
  const focused = documentPort.activeElement;
  if (focused !== request.opener && focused !== documentPort.body) return false;
  panel.focus();
  return true;
}

export interface ManagementWorkspaceTab { id: ManagementWorkspaceSection; label: string; count?: number }

/** Presentation-only transitions. A review can never be stranded in a hidden panel. */
export function managementWorkspaceNextSection(current: ManagementWorkspaceSection, next: ManagementWorkspaceSection, locked: boolean): ManagementWorkspaceSection {
  return locked ? current : next;
}
/** Manual-activation tabs: arrow keys move focus, Enter/Space activates naturally. */
export function managementWorkspaceFocusIndex(index: number, count: number, key: string): number | null {
  if (count < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index + count - 1) % count;
  return null;
}

export function ManagementWorkspace({ id, active, tabs, navigationLabel, locked, reviewLabel, onSelect, map, children, focusRequest }: {
  focusRequest?: ManagementWorkspaceFocusRequest | null;
  id: string; active: ManagementWorkspaceSection; tabs: readonly ManagementWorkspaceTab[];
  navigationLabel: string; locked: boolean; reviewLabel: string;
  onSelect: (section: ManagementWorkspaceSection) => void; map: ReactNode; children: ReactNode;
}) {
  const workspace = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const consumedFocus = useRef<ManagementWorkspaceFocusRequest | null>(null);
  // Measure the actual wrapping header instead of assuming a fixed toolbar height.
  // A minimum keeps short/zoomed windows usable through ordinary document scroll.
  useEffect(() => {
    const element = workspace.current; if (!element) return;
    const measure = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.setProperty('--management-workspace-height', `${Math.max(352, Math.floor(window.innerHeight - top - 20))}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const shell = element.closest('main');
    if (shell) for (const child of shell.children) observer?.observe(child);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  useEffect(() => {
    // Each category begins at its heading; inputs and drafts remain mounted.
    if (panel.current) panel.current.scrollTop = 0;
    navigation.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  useEffect(() => {
    if (!focusRequest || consumedFocus.current === focusRequest || focusRequest.section !== active) return;
    consumedFocus.current = focusRequest;
    if (panel.current) focusManagementWorkspacePanel(focusRequest, active, panel.current, document);
  }, [focusRequest, active]);
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = managementWorkspaceFocusIndex(index, tabs.length, event.key);
    if (next === null) return;
    event.preventDefault();
    const target = navigation.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next];
    target?.focus(); target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  return <>
    <div className="management-workspace-navigation" ref={navigation} role="tablist" aria-label={navigationLabel} aria-describedby={locked ? `${id}-review-lock` : undefined}>
      {tabs.map((tab, index) => <button type="button" role="tab" key={tab.id} id={`${id}-tab-${tab.id}`}
        aria-selected={active === tab.id} aria-controls={tab.id === 'overview' ? `${id}-map` : `${id}-detail`}
        aria-disabled={locked && active !== tab.id} tabIndex={active === tab.id ? 0 : -1}
        onKeyDown={event => moveFocus(event, index)} onClick={() => onSelect(managementWorkspaceNextSection(active, tab.id, locked))}>
        <span>{tab.label}</span>{tab.count !== undefined && <span className="management-workspace-count">{tab.count}</span>}
      </button>)}
    </div>
    {locked && <p id={`${id}-review-lock`} className="management-workspace-review-lock" role="status">{reviewLabel}</p>}
    <div className="management-workspace" data-section={active} ref={workspace}>
      <div id={`${id}-map`} className="management-workspace-map" role={active === 'overview' ? 'tabpanel' : undefined}
        aria-labelledby={active === 'overview' ? `${id}-tab-overview` : undefined}>{map}</div>
      <div id={`${id}-detail`} className="management-workspace-detail" ref={panel} role={active === 'overview' ? 'region' : 'tabpanel'}
        tabIndex={0} aria-labelledby={`${id}-tab-${active === 'overview' ? 'roster' : active}`}>
        {children}
      </div>
    </div>
  </>;
}

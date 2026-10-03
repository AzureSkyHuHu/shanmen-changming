import { useRef } from 'react';
import './workspace-tabs.css';

export interface WorkspaceTab<Id extends string> { readonly id: Id; readonly label: string }
/** View-only navigation. Panels stay mounted so changing a category never submits
 * or discards an in-progress form. Arrow keys move and activate one tab. */
export function workspaceTabIndex(key: string, current: number, count: number): number | null {
  if (count < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current + count - 1) % count;
  return null;
}
export function WorkspaceTabs<Id extends string>({ id, label, tabs, selected, onSelect }: {
  id: string; label: string; tabs: readonly WorkspaceTab<Id>[]; selected: Id; onSelect: (id: Id) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return <div className="workspace-tabs" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button type="button" className="secondary" role="tab" id={`${id}-tab-${tab.id}`} key={tab.id}
      ref={element => { buttons.current[index] = element; }} aria-controls={`${id}-panel-${tab.id}`} aria-selected={selected === tab.id}
      tabIndex={selected === tab.id ? 0 : -1} onClick={() => onSelect(tab.id)} onKeyDown={event => {
        const next = workspaceTabIndex(event.key, index, tabs.length);
        if (next === null) return;
        event.preventDefault(); event.stopPropagation();
        onSelect(tabs[next]!.id); buttons.current[next]?.focus();
      }}>{tab.label}</button>)}
  </div>;
}
export function workspacePanel(id: string, tab: string, selected: string) {
  return { id: `${id}-panel-${tab}`, role: 'tabpanel' as const, 'aria-labelledby': `${id}-tab-${tab}`, hidden: tab !== selected, tabIndex: 0 };
}

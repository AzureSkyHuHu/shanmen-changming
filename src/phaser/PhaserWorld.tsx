import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApplicationSession } from '../application/session';
import { translate, type Locale } from '../i18n';
import type { SectRenderer } from './create-sect-game';
import { createLegacySectRendererSource, type SectRendererSource } from './sect-renderer-contract';

export type PhaserWorldProps = { locale: Locale } & (
  | { session: ApplicationSession; source?: never }
  | { source: SectRendererSource; session?: never }
);
export function PhaserWorld(props: PhaserWorldProps) {
  const { locale } = props;
  const source = useMemo(() => props.session ? createLegacySectRendererSource(props.session) : props.source, [props.session, props.source]);
  const element = useRef<HTMLDivElement>(null);
  const renderer = useRef<SectRenderer | null>(null);
  const currentLocale = useRef(locale);
  const [initialZoom] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 620px)').matches ? 1.8 : 1.1);
  const [zoom, setZoom] = useState(initialZoom);
  const [failed, setFailed] = useState(false);
  currentLocale.current = locale;
  useEffect(() => {
    let disposed = false;
    setFailed(false);
    // Import only after mounting: SSR and core tests never boot Phaser or touch the DOM.
    void import('./create-sect-game').then(({ mountSectWorld }) => {
      if (disposed || !element.current) return;
      renderer.current = mountSectWorld(element.current, source, currentLocale.current);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; renderer.current?.destroy(); renderer.current = null; };
  }, [source]);
  useEffect(() => { renderer.current?.setLocale(locale); }, [locale]);
  const changeZoom = (value: number) => { const next = Math.max(0.85, Math.min(2.2, value)); setZoom(next); renderer.current?.setZoom(next); };
  return <div className="world-stage">
    <div className="world-canvas" ref={element} role="img" aria-label={translate(locale, 'live.worldLabel')}>
    {failed && <p className="canvas-error" role="alert">{translate(locale, 'live.renderError')}</p>}
    </div>
    <div className="map-controls">
      <button type="button" aria-label={translate(locale, 'live.zoomOut')} title={translate(locale, 'live.zoomOut')} onClick={() => changeZoom(zoom - 0.15)} disabled={zoom <= 0.85}>−</button>
      <button type="button" aria-label={translate(locale, 'live.resetView')} title={translate(locale, 'live.resetView')} onClick={() => { setZoom(initialZoom); renderer.current?.resetView(); }}>⌂</button>
      <button type="button" aria-label={translate(locale, 'live.zoomIn')} title={translate(locale, 'live.zoomIn')} onClick={() => changeZoom(zoom + 0.15)} disabled={zoom >= 2.2}>+</button>
    </div>
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import type { ApplicationSession } from '../application/session';
import { translate, type Locale } from '../i18n';
import type { SectRenderer } from './create-sect-game';

export function PhaserWorld({ session, locale }: { session: ApplicationSession; locale: Locale }) {
  const element = useRef<HTMLDivElement>(null);
  const renderer = useRef<SectRenderer | null>(null);
  const currentLocale = useRef(locale);
  const [failed, setFailed] = useState(false);
  currentLocale.current = locale;
  useEffect(() => {
    let disposed = false;
    // Import only after mounting: SSR and core tests never boot Phaser or touch the DOM.
    void import('./create-sect-game').then(({ mountSectWorld }) => {
      if (disposed || !element.current) return;
      renderer.current = mountSectWorld(element.current, session, currentLocale.current);
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; renderer.current?.destroy(); renderer.current = null; };
  }, [session]);
  useEffect(() => { renderer.current?.setLocale(locale); }, [locale]);
  return <div className="world-canvas" ref={element} role="img" aria-label={translate(locale, 'live.worldLabel')}>
    {failed && <p className="canvas-error" role="alert">{translate(locale, 'live.renderError')}</p>}
  </div>;
}

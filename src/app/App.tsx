import { useEffect, useState } from 'react';
import {
  DEFAULT_LOCALE,
  readLocalePreference,
  translate,
  writeLocalePreference,
  type Locale,
} from '../i18n';

export interface AppProps {
  /** Presentation-only override for previews and tests; never world state. */
  initialLocale?: Locale;
}

/** Foundation shell. The landscape is illustrative, not a simulation projection. */
export function App({ initialLocale }: AppProps) {
  const [locale, setLocale] = useState<Locale>(
    () => initialLocale ?? readLocalePreference() ?? DEFAULT_LOCALE,
  );
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, 'app.title');
  }, [locale]);

  function selectLocale(nextLocale: string) {
    if (nextLocale !== 'zh-CN' && nextLocale !== 'en') return;
    setLocale(nextLocale);
    writeLocalePreference(nextLocale);
  }

  return (
    <main className="game-shell" lang={locale}>
      <header className="shell-header">
        <div className="brand">
          <svg className="brand-seal" viewBox="0 0 40 48" aria-hidden="true">
            <rect x="1" y="1" width="38" height="46" rx="3" />
            <path d="M9 32V20M20 32V13M31 32V20M9 32H31M10 38H30" />
          </svg>
          <div>
            <h1>{t('app.title')}</h1>
            <p className="brand-subtitle">{t('app.subtitle')}</p>
          </div>
        </div>
        <label className="language-control">
          <span>{t('settings.language.label')}</span>
          <select
            value={locale}
            onChange={(event) => selectLocale(event.currentTarget.value)}
            aria-label={t('settings.language.switch')}
          >
            <option value="zh-CN">{t('settings.language.zh-CN')}</option>
            <option value="en">{t('settings.language.en')}</option>
          </select>
        </label>
      </header>

      <section className="scene-frame" aria-label={t('app.scene.label')}>
        <svg className="mountain-scene" viewBox="0 0 1440 660" preserveAspectRatio="xMidYMid slice" role="img" aria-labelledby="scene-title">
          <title id="scene-title">{t('app.scene.label')}</title>
          <defs>
            <linearGradient id="sky" x2="0" y2="1">
              <stop offset="0" stopColor="#152e33" />
              <stop offset="1" stopColor="#799082" />
            </linearGradient>
            <linearGradient id="mist" x2="0" y2="1">
              <stop offset="0" stopColor="#c9d5bd" stopOpacity="0" />
              <stop offset="1" stopColor="#c9d5bd" stopOpacity="0.24" />
            </linearGradient>
            <radialGradient id="lantern">
              <stop stopColor="#f8d396" stopOpacity="0.55" />
              <stop offset="1" stopColor="#f8d396" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path fill="url(#sky)" d="M0 0H1440V660H0Z" />
          <circle cx="1070" cy="126" r="43" fill="#e8ddaf" opacity="0.82" />
          <path d="M0 260L122 163 217 248 300 110 345 154 387 102 540 299 684 198 787 275 890 127 1034 284 1157 205 1234 236 1360 116 1440 181V660H0Z" fill="#60796f" />
          <path d="M0 407L98 312 173 370 302 251 366 284 425 246 561 426 682 306 731 326 823 253 953 393 1039 311 1148 364 1287 230 1440 362V660H0Z" fill="#3f635e" />
          <path d="M0 436Q254 356 509 448T967 404T1440 427V575H0Z" fill="url(#mist)" />
          <path d="M0 506L160 437 306 494 488 367 548 388 636 344 779 444 930 377 1071 480 1237 393 1440 478V660H0Z" fill="#264947" />
          <path d="M410 660L543 571 641 559 723 510 842 500 803 486 704 492 612 539 526 547 327 660Z" fill="#6d7c67" />
          <path d="M531 573L558 577M552 560L580 565M580 551L606 556M613 544L636 548M649 529L670 534M676 516L696 520M705 504L728 509M750 499L767 504" stroke="#b6b595" strokeWidth="3" opacity="0.56" />
          <path d="M752 489H885L858 476H772Z" fill="#243333" />
          <path d="M770 419H870V479H770Z" fill="#3c4440" />
          <path d="M789 430H815V479H789ZM830 430H850V479H830Z" fill="#1a302f" />
          <path d="M758 414L790 399H849L881 414 894 415 886 422H750L742 415Z" fill="#1b3334" />
          <path d="M774 397L800 380H840L866 397 878 399 870 405H770L761 399Z" fill="#1a3234" />
          <path d="M797 381L816 362 823 362 843 381Z" fill="#1d3534" />
          <path d="M788 422V479M854 422V479" stroke="#87765b" strokeWidth="5" />
          <circle cx="821" cy="451" r="74" fill="url(#lantern)" />
          <path d="M817 433H825V447H817Z" fill="#f3c983" />
          <path d="M821 425V433M821 447V452" stroke="#dcb27a" strokeWidth="2" />
          <path d="M0 596L93 558 164 572 194 553 271 584 316 580 369 660H0ZM1112 660L1170 553 1210 568 1266 530 1350 557 1440 512V660Z" fill="#183a38" />
          <g fill="#193a37">
            <path d="M194 542V417H201V542ZM157 455L197 409 236 455ZM151 484L197 433 243 484ZM139 516L197 460 251 516Z" />
            <path d="M1291 551V333H1301V551ZM1238 397L1296 316 1353 397ZM1220 449L1296 355 1375 449ZM1201 507L1296 400 1391 507Z" />
          </g>
          <path d="M545 180L552 176 560 180M566 188L572 184 579 188" fill="none" stroke="#d6d4b5" strokeWidth="2" opacity="0.5" />
        </svg>
        <div className="scene-vignette" aria-hidden="true" />
        <div className="scene-caption">
          <span className="fine-rule" aria-hidden="true" />
          <p>{t('app.scene.caption')}</p>
        </div>
        <div className="preview-note">
          <span className="preview-tag">{t('app.foundation.label')}</span>
          <p>{t('app.foundation.detail')}</p>
        </div>
      </section>

      <section className="development-note" aria-labelledby="development-title">
        <div className="development-heading">
          <p className="phase-label">{t('app.phase')}</p>
          <h2 id="development-title">{t('app.next.title')}</h2>
          <p>{t('app.next.description')}</p>
        </div>
        <div className="development-status" role="status">
          <p className="status-line"><span className="status-mark" aria-hidden="true" />{t('app.status')}</p>
          <p className="status-hint">{t('app.hint')}</p>
        </div>
      </section>
    </main>
  );
}

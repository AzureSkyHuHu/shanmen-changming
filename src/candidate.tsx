import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppProps } from './app/App';
import { translate, type TextKey } from './i18n';
import './app/app.css';

/** A fixed development-only destination. Never look up, copy, or migrate ordinary browser slots. */
export const CANDIDATE_DATABASE_NAME = 'shanmen-changming-v8-candidate-saves';
const candidateRepositoryOptions = Object.freeze({ databaseName: CANDIDATE_DATABASE_NAME });

export function CandidatePreviewNotice() {
  return <aside role="note" style={{ padding: '12px 16px', marginBottom: 16, border: '1px solid #a5915d', borderRadius: 6, background: '#263c30', color: '#fff0c7', fontSize: 13, lineHeight: 1.7 }}>
    <p lang="zh-CN">{translate('zh-CN', 'candidate.banner')}</p>
    <p lang="en">{translate('en', 'candidate.banner')}</p>
  </aside>;
}

function CandidateUnavailable({ message }: { message: Extract<TextKey, 'candidate.locked' | 'candidate.unavailable'> }) {
  return <main className="game-shell" lang="zh-CN">
    <h1>{translate('zh-CN', 'app.title')}</h1>
    <CandidatePreviewNotice />
    <p lang="zh-CN">{translate('zh-CN', message)}</p>
    <p lang="en">{translate('en', message)}</p>
  </main>;
}

/** Exact opt-in only: no truthy coercion, URL switch, storage preference, or runtime setting. */
export async function candidatePreviewProps(buildFlag: unknown): Promise<Required<Pick<AppProps, 'newWorldFactory' | 'saveRepositoryOptions' | 'previewNotice'>> | null> {
  if (buildFlag !== '1') return null;
  const { createWorldV8 } = await import('./core/kernel/v8');
  return { newWorldFactory: createWorldV8, saveRepositoryOptions: candidateRepositoryOptions, previewNotice: <CandidatePreviewNotice /> };
}

/** Only the compile-time environment controls the actual entry, never a caller-provided flag. */
export async function mountCandidatePreview(container: HTMLElement): Promise<void> {
  const root = createRoot(container);
  try {
    const props = await candidatePreviewProps(import.meta.env.VITE_ENABLE_V8_CANDIDATE);
    if (!props) {
      root.render(<CandidateUnavailable message="candidate.locked" />);
      return;
    }
    // The disabled route must not load App, instantiate a Session, or attach storage/runtime.
    const { App } = await import('./app/App');
    root.render(<StrictMode><App {...props} /></StrictMode>);
  } catch {
    root.render(<CandidateUnavailable message="candidate.unavailable" />);
  }
}

if (typeof document !== 'undefined') {
  const container = document.getElementById('candidate-root');
  if (!container) throw new Error('Missing candidate preview root element.');
  void mountCandidatePreview(container);
}

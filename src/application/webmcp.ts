import type { ApplicationSession } from './session';

export interface GameStatusTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: true; untrustedContentHint: true };
  execute(input: unknown): unknown;
}
export interface GameModelContext {
  registerTool(tool: GameStatusTool, options?: { signal?: AbortSignal }): void | Promise<void>;
}

/** Optional, page-local read adapter. Never writes state, advances time or uses RNG. */
export function registerGameStatus(context: GameModelContext | undefined, session: Pick<ApplicationSession, 'getSnapshot'>, description: string): () => void {
  if (!context?.registerTool) return () => undefined;
  const lifecycle = new AbortController();
  try {
    void Promise.resolve(context.registerTool({
      name: 'get_sect_status', description,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) throw new TypeError('INVALID_INPUT');
        const view = session.getSnapshot();
        return {
          phase: 'development', tick: view.clock.simulationTick,
          calendar: { ...view.calendar }, paused: view.paused,
          resources: view.resources.map(({ resourceId, owned, available, reserved }) => ({ resourceId, owned, available, reserved })),
          disciples: view.disciples.length,
          activeJobs: view.disciples.filter((entry) => entry.assignmentTransactionId !== null).length,
        };
      },
    }, { signal: lifecycle.signal })).catch(() => lifecycle.abort());
  } catch { lifecycle.abort(); }
  return () => lifecycle.abort();
}

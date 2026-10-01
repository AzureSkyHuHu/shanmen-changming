import { describe, expect, it } from 'vitest';
import { ApplicationSession } from '../../src/application/session';
import { registerGameStatus, type GameStatusTool } from '../../src/application/webmcp';

describe('optional read-only page tool', () => {
  it('uses visible projection without changing state and cleans up registration', () => {
    const session = new ApplicationSession();
    let tool: GameStatusTool | undefined;
    let signal: AbortSignal | undefined;
    const before = session.getSnapshot();
    const stop = registerGameStatus({ registerTool(value, options) { tool = value; signal = options?.signal; } }, session, 'Read current game status');
    expect(tool?.name).toBe('get_sect_status');
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(tool?.execute({})).toMatchObject({ phase: 'development', tick: 0, disciples: 4 });
    expect(() => tool?.execute({ mutate: true })).toThrow('INVALID_INPUT');
    expect(session.getSnapshot()).toBe(before);
    stop();
    expect(signal?.aborted).toBe(true);
  });
  it('is harmless when unsupported or registration fails', () => {
    const session = new ApplicationSession();
    expect(() => registerGameStatus(undefined, session, 'Read')()).not.toThrow();
    expect(() => registerGameStatus({ registerTool() { throw new Error('unavailable'); } }, session, 'Read')()).not.toThrow();
  });
});

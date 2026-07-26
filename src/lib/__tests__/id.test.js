import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateId } from '../id.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('produces a v4 UUID that validateQuery will accept', () => {
    expect(generateId()).toMatch(UUID_V4);
  });

  it('prefers crypto.randomUUID when available', () => {
    const spy = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID: spy });
    expect(generateId()).toBe('11111111-2222-4333-8444-555555555555');
    expect(spy).toHaveBeenCalled();
  });

  // crypto.randomUUID is undefined on a plain-HTTP origin, which is exactly where a
  // self-hosted LAN deployment runs, so the fallback must still produce a valid v4.
  it('falls back to a valid v4 when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {});
    const id = generateId();
    expect(id).toMatch(UUID_V4);
  });

  it('does not collide across many calls', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => generateId()));
    expect(seen.size).toBe(5000);
  });
});

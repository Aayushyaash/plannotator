/**
 * The line under the person's last message (deliveryLine.ts). The failure
 * this catches: the owner's report, a reply to a working agent that read
 * "Saved for Claude Code. It sees it when it checks.", as if it were dropped
 * or the agent had to poll for it.
 */
import { describe, expect, test } from 'bun:test';
import { deliveryLine, sentRowLine, type DeliveryLineInput } from './deliveryLine';

const base: DeliveryLineInput = {
  name: 'Claude Code',
  deliveredAt: null,
  time: () => '5:12 PM',
  wakes: true,
  sendingNow: false,
  connection: undefined,
};

describe('the line under a sent reply', () => {
  test('a waking agent at work: queued until its turn ends, with Send now where its connection can take it', () => {
    expect(deliveryLine({ ...base, connection: { busy: true, idle_since: null, send_now: true } })).toEqual({
      state: 'queued',
      text: 'Queued · Claude Code is working; it gets this when its turn ends.',
      sendNow: true,
    });
    expect(deliveryLine({ ...base, connection: { busy: true, idle_since: null, send_now: false } }).sendNow).toBe(false);
  });

  test('idle: sending; after Send now: sending now; delivered: unchanged', () => {
    expect(deliveryLine({ ...base, connection: { busy: false, idle_since: '2026-10-16T17:00:00.000Z', send_now: true } })).toEqual({ state: 'sending', text: 'Sending to Claude Code…' });
    expect(deliveryLine({ ...base, sendingNow: true, connection: { busy: true, idle_since: null, send_now: true } })).toEqual({ state: 'sending', text: 'Sending to Claude Code now…' });
    expect(deliveryLine({ ...base, deliveredAt: '2026-10-16T17:12:00.000Z', connection: { busy: true, idle_since: null, send_now: true } })).toEqual({
      state: 'delivered',
      text: 'Delivered to Claude Code, 5:12 PM',
    });
  });

  test("pressed while the session cannot take it (its own Ask question holds it): queued, no second button", () => {
    expect(deliveryLine({ ...base, sendingNow: true, connection: { busy: true, idle_since: null, send_now: false } })).toEqual({
      state: 'queued',
      text: 'Queued · Claude Code is working; it gets this when its turn ends.',
      sendNow: false,
    });
  });

  test('not known yet, a connection that does not say, a session not connected now', () => {
    expect(deliveryLine(base).text).toBe('Queued for Claude Code; it gets this as its next turn.');
    expect(deliveryLine({ ...base, connection: { busy: null, idle_since: null, send_now: false } }).text).toBe('Queued for Claude Code; it gets this as its next turn.');
    expect(deliveryLine({ ...base, connection: null }).text).toBe('Queued for Claude Code; it gets this when its session is back.');
  });

  test('an agent that only reads the thread keeps the truthful wording and never offers Send now', () => {
    const line = deliveryLine({ ...base, wakes: false, connection: { busy: true, idle_since: null, send_now: true } });
    expect(line).toEqual({ state: 'saved', text: 'Saved for Claude Code. It sees it when it next reads this thread.' });
  });

  test('the asking session ended, or a message addressed to a session that stopped: the existing lines', () => {
    expect(deliveryLine({ ...base, askerEnded: { name: 'Claude Code' } })).toMatchObject({ state: 'saved', ended: true });
    expect(deliveryLine({ ...base, undelivered: { host: 'Pi' } }).state).toBe('undelivered');
  });

  test("the Sent row: queued for a waking agent, saved for one that reads the thread (and from an older Inbox)", () => {
    expect(sentRowLine('Pi', true)).toBe('Queued for Pi; it gets this as its next turn.');
    expect(sentRowLine('Codex', false)).toBe('Saved for Codex. It sees it when it next reads this thread.');
    expect(sentRowLine('Codex', undefined)).toBe('Saved for Codex. It sees it when it next reads this thread.');
  });
});

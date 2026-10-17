import { describe, expect, test } from 'bun:test'
import { engineHasSessionAppend, SESSION_APPEND_MIN_ENGINE } from './inbox'

// Send now is offered only on an engine whose API has `$.session.append`; the
// failure this catches: an older Claude Code offered Send now, and the reply
// then waited for idle anyway while the window said "Sending now".
describe('engineHasSessionAppend', () => {
  test('the floor and later releases have it; older, development-only and unreadable versions do not', () => {
    expect(SESSION_APPEND_MIN_ENGINE).toBe('2.1.301')
    expect(engineHasSessionAppend('2.1.301')).toBe(true)
    expect(engineHasSessionAppend('2.1.302')).toBe(true)
    expect(engineHasSessionAppend('2.2.0')).toBe(true)
    expect(engineHasSessionAppend('3.0.0')).toBe(true)
    expect(engineHasSessionAppend('2.1.310-dev')).toBe(true)
    expect(engineHasSessionAppend('2.1.300')).toBe(false)
    expect(engineHasSessionAppend('2.1.290-dev')).toBe(false)
    expect(engineHasSessionAppend('2.0.999')).toBe(false)
    expect(engineHasSessionAppend('')).toBe(false)
    expect(engineHasSessionAppend(undefined)).toBe(false)
    expect(engineHasSessionAppend('dev')).toBe(false)
  })
})

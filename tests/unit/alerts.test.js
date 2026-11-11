'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { scanClosingSoonAlerts } = require('../../lib/operational/alerts');

describe('operational/alerts scanClosingSoonAlerts', () => {
  const now = new Date('2026-01-01T00:00:00.000Z').getTime();
  const inHours = h => new Date(now + h * 3600000).toISOString();

  test('returns empty list for missing or malformed snapshots', () => {
    assert.deepStrictEqual(scanClosingSoonAlerts(null), []);
    assert.deepStrictEqual(scanClosingSoonAlerts(undefined), []);
    assert.deepStrictEqual(scanClosingSoonAlerts({}), []);
    assert.deepStrictEqual(scanClosingSoonAlerts({ jobs: {} }, 48, now), []);
  });

  test('includes only open jobs inside the window, sorted by remaining time', () => {
    const snapshot = {
      jobs: {
        a: { id: 'a', title: 'Engineer', company: 'Acme', deadlineAt: inHours(40), status: 'shortlisted' },
        b: { id: 'b', title: 'Designer', company: 'Example Co', closingDate: inHours(10), status: 'discovered' },
        c: { id: 'c', title: 'Far Future', company: 'Acme', deadline: inHours(200), status: 'discovered' },
        d: { id: 'd', title: 'Closed Role', company: 'Acme', deadlineAt: inHours(5), status: 'closed' },
        e: { id: 'e', title: 'Expired Role', company: 'Acme', deadlineAt: inHours(-2), status: 'discovered' },
        f: { id: 'f', title: 'No Deadline', company: 'Acme', status: 'discovered' },
        g: { id: 'g', title: 'Bad Date', company: 'Acme', deadlineAt: 'not-a-date', status: 'discovered' }
      }
    };
    const alerts = scanClosingSoonAlerts(snapshot, 48, now);
    assert.deepStrictEqual(alerts.map(a => a.id), ['b', 'a']);
    assert.strictEqual(alerts[0].urgency, 'CRITICAL');
    assert.strictEqual(alerts[1].urgency, 'HIGH');
    assert.strictEqual(alerts[0].remainingHours, 10);
  });

  test('honours a narrower custom window', () => {
    const snapshot = {
      jobs: {
        a: { id: 'a', title: 'Engineer', company: 'Acme', deadlineAt: inHours(30), status: 'shortlisted' }
      }
    };
    assert.deepStrictEqual(scanClosingSoonAlerts(snapshot, 24, now), []);
    assert.strictEqual(scanClosingSoonAlerts(snapshot, 48, now).length, 1);
  });

  test('accepts Date reference times and rejects non-object job rows', () => {
    const snapshot = { jobs: { a: null, b: 'junk', c: { id: 'c', deadlineAt: inHours(2), status: 'open' } } };
    const alerts = scanClosingSoonAlerts(snapshot, 48, new Date(now));
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(alerts[0].id, 'c');
  });
});

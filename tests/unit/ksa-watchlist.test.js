'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  KsaCountryPack,
  KsaWatchlistRegistry,
  KSA_WATCHLIST
} = require('../../lib/discovery/ksa-pack');
const { getDefaultSweepTargets } = require('../../lib/cli/commands/discover');

describe('KsaWatchlistRegistry.findByCompanyName', () => {
  const registry = new KsaWatchlistRegistry();

  test('single generic corporate words do not match any enterprise', () => {
    for (const generic of ['Company', 'Bank', 'Group', 'Holding', 'Solutions', 'Air', 'Saudi']) {
      assert.strictEqual(
        registry.findByCompanyName(generic), null,
        `findByCompanyName(${JSON.stringify(generic)}) must be null`
      );
    }
    assert.strictEqual(registry.findByCompanyName('Saudi Company'), null);
    assert.strictEqual(registry.findByCompanyName('The Company'), null);
  });

  test('non-string and empty queries return null', () => {
    assert.strictEqual(registry.findByCompanyName(''), null);
    assert.strictEqual(registry.findByCompanyName(null), null);
    assert.strictEqual(registry.findByCompanyName(undefined), null);
    assert.strictEqual(registry.findByCompanyName(42), null);
  });

  test('exact and alias forms of real watchlist companies still match', () => {
    // NEOM (id "neom"): exact name, suffixed form, and JSON alias "The Line".
    assert.strictEqual(registry.findByCompanyName('NEOM')?.id, 'neom');
    assert.strictEqual(registry.findByCompanyName('NEOM Company')?.id, 'neom');
    assert.strictEqual(registry.findByCompanyName('The Line')?.id, 'neom');

    // Saudi Aramco (id "saudi-aramco"): exact name and JSON alias "Aramco".
    assert.strictEqual(registry.findByCompanyName('Saudi Aramco')?.id, 'saudi-aramco');
    assert.strictEqual(registry.findByCompanyName('Aramco')?.id, 'saudi-aramco');
  });

  test('names built from distinctive tokens plus generic suffixes still match', () => {
    assert.strictEqual(registry.findByCompanyName('Al Rajhi Bank')?.id, 'al-rajhi-bank');
    assert.strictEqual(registry.findByCompanyName('Riyadh Air')?.id, 'riyadh-air');
    assert.strictEqual(registry.findByCompanyName('Solutions by stc')?.id, 'solutions-by-stc');
    assert.strictEqual(registry.findByCompanyName('Red Sea Global')?.id, 'red-sea-global');
    assert.strictEqual(registry.findByCompanyName('RSG')?.id, 'red-sea-global');
    assert.strictEqual(registry.findByCompanyName('stc')?.id, 'stc');
  });

  test('KsaCountryPack.getWatchlist returns the enabled watchlist entries', () => {
    const entries = KsaCountryPack.getWatchlist();
    assert.ok(Array.isArray(entries));
    assert.strictEqual(entries.length, KSA_WATCHLIST.filter(e => e.enabled !== false).length);
    assert.ok(entries.length >= 40);
    assert.ok(entries.some(e => e.id === 'neom'));
  });
});

describe('discover getDefaultSweepTargets', () => {
  test('derives targets from the watchlist instead of a fixed slug list', () => {
    const targets = getDefaultSweepTargets();
    assert.ok(targets.length > 4, `expected >4 dynamic targets, got ${targets.length}`);
    for (const t of targets) {
      assert.ok(t.provider && typeof t.provider === 'string');
      assert.ok(t.slug && typeof t.slug === 'string');
      assert.strictEqual(t.boardToken, t.slug);
      assert.ok(t.company && typeof t.company === 'string');
    }
    const keys = targets.map(t => `${t.provider}:${t.slug.toLowerCase()}`);
    const fullKeys = targets.map(t => `${t.provider}:${JSON.stringify(t.target)}`);
    assert.strictEqual(new Set(fullKeys).size, fullKeys.length, 'targets are de-duplicated');
    // The previously hardcoded boards are all present via the watchlist.
    // Boards verified live (HTTP 200 with jobs); the earlier guessed slugs all 404'd.
    for (const expected of [
      'workable:salla',
      'greenhouse:tamara',
      'ashby:leantech',
      'smartrecruiters:deliveryhero'
    ]) {
      assert.ok(keys.includes(expected), `missing expected target ${expected}`);
    }
    // Companies come from real watchlist entries.
    const watchlistNames = new Set(KsaCountryPack.getWatchlist().map(e => e.name));
    assert.ok(targets.every(t => watchlistNames.has(t.company)));
  });

  test('skips entries without a supported provider or usable board slug', () => {
    const targets = getDefaultSweepTargets([
      { id: 'plain', name: 'Plain Careers Page', provider: 'oraclecloud', careersUrl: 'https://example.com/careers', enabled: true },
      { id: 'sf', name: 'Unsupported Provider Co', provider: 'successfactors', careersUrl: 'https://example.com/careers', enabled: true },
      { id: 'off', name: 'Disabled Board Co', provider: 'greenhouse', careersUrl: 'https://boards.greenhouse.io/disabledco', enabled: false },
      { id: 'ok', name: 'Board Co', provider: 'greenhouse', careersUrl: 'https://boards.greenhouse.io/boardco', enabled: true },
      { id: 'tok', name: 'Token Co', provider: 'lever', boardToken: 'tokenco', enabled: true }
    ]);
    assert.deepStrictEqual(
      targets.map(t => `${t.provider}:${t.slug}:${t.company}`).sort(),
      ['greenhouse:boardco:Board Co', 'lever:tokenco:Token Co']
    );
  });

  test('falls back to the built-in boards only when the watchlist yields none', () => {
    const targets = getDefaultSweepTargets([]);
    assert.strictEqual(targets.length, 4);
    assert.ok(targets.some(t => t.provider === 'workable' && t.slug === 'salla'));
  });
});

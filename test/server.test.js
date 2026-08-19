import test from 'node:test';
import assert from 'node:assert/strict';
import { creditsForPlan, ensureWallet, FREE_DAILY_CREDITS, nextRefreshUtc, todayKey } from '../server/index.js';

test('free wallet starts with 8 daily video credits', () => {
  const db = { users: {}, jobs: {} };
  const wallet = ensureWallet(db, 'client-a', new Date('2026-08-19T10:00:00Z'));
  assert.equal(wallet.plan, 'free');
  assert.equal(wallet.credits, FREE_DAILY_CREDITS);
  assert.equal(wallet.refreshedAt, '2026-08-19');
});

test('free wallet refreshes to 8 credits on a new UTC day', () => {
  const db = { users: { 'client-a': { plan: 'free', credits: 0, refreshedAt: '2026-08-18' } }, jobs: {} };
  const wallet = ensureWallet(db, 'client-a', new Date('2026-08-19T00:00:01Z'));
  assert.equal(wallet.credits, 8);
  assert.equal(wallet.refreshedAt, '2026-08-19');
});

test('pro wallet refreshes to pro allowance', () => {
  const db = { users: { 'client-pro': { plan: 'pro', credits: 0, refreshedAt: '2026-08-18' } }, jobs: {} };
  const wallet = ensureWallet(db, 'client-pro', new Date('2026-08-19T00:00:01Z'));
  assert.equal(wallet.credits, creditsForPlan('pro'));
  assert.equal(wallet.refreshedAt, '2026-08-19');
});

test('UTC date helpers are stable', () => {
  const date = new Date('2026-12-31T23:59:59Z');
  assert.equal(todayKey(date), '2026-12-31');
  assert.equal(nextRefreshUtc(date), '2027-01-01T00:00:00.000Z');
});

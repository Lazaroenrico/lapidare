const {test} = require('node:test');
const assert = require('node:assert/strict');
const {partitionTrayJobs} = require('../.test-build/jobs-tray.js');

const NOW = Date.parse('2026-10-27T12:00:00Z');
const H = 3600 * 1000;
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();
const job = (job_id, status, extra = {}) => ({job_id, kind: 'research', label: job_id, status, ...extra});

test('records fold by job_id: the last one wins', () => {
  const {running, failed} = partitionTrayJobs(
    [job('a', 'queued'), job('b', 'running'), job('a', 'running'), job('b', 'failed', {updated_at: iso(H)})],
    NOW,
  );
  assert.deepEqual(running.map((j) => j.job_id), ['a']);
  assert.equal(running[0].status, 'running');
  assert.deepEqual(failed.map((j) => j.job_id), ['b']);
});

test('failures outside the 24h window drop out; missing or invalid dates stay', () => {
  const {failed} = partitionTrayJobs(
    [
      job('old', 'failed', {updated_at: iso(25 * H)}),
      job('new', 'failed', {updated_at: iso(2 * H)}),
      job('nodate', 'failed'),
      job('bad', 'failed', {updated_at: 'nope'}),
      job('created', 'failed', {created_at: iso(30 * H)}),
    ],
    NOW,
  );
  assert.deepEqual(failed.map((j) => j.job_id).sort(), ['bad', 'new', 'nodate']);
  assert.deepEqual(partitionTrayJobs([job('x', 'failed', {updated_at: iso(3 * H)})], NOW, 2 * H).failed, []);
});

test('failed jobs come most recent first and interrupted counts as failure', () => {
  const {failed} = partitionTrayJobs(
    [
      job('a', 'failed', {updated_at: iso(5 * H)}),
      job('b', 'interrupted', {updated_at: iso(1 * H)}),
      job('c', 'failed', {created_at: iso(3 * H)}),
      job('d', 'completed', {updated_at: iso(H)}),
    ],
    NOW,
  );
  assert.deepEqual(failed.map((j) => j.job_id), ['b', 'c', 'a']);
});

test('a retry that goes back to running leaves the failed list', () => {
  const {running, failed} = partitionTrayJobs(
    [job('a', 'failed', {updated_at: iso(H)}), job('a', 'running', {updated_at: iso(0)})],
    NOW,
  );
  assert.deepEqual(failed, []);
  assert.deepEqual(running.map((j) => j.job_id), ['a']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateJournal } from '../src/journal.mjs';

test('journal commits serialized state durably and excludes concurrent writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniarb-journal-'));
  const path = join(directory, 'ledger.local.json');
  try {
    const first = await updateJournal(path, previous => {
      assert.equal(previous, null);
      return '{"reserved":"100"}';
    });
    assert.equal(await readFile(path, 'utf8'), first);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await updateJournal(path, async previous => {
      assert.equal(JSON.parse(previous).reserved, '100');
      await assert.rejects(updateJournal(path, () => '{}'), { code: 'EEXIST' });
      return '{"reserved":"50"}';
    });
    assert.equal(JSON.parse(await readFile(path, 'utf8')).reserved, '50');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed journal update preserves original state and fails closed on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'omniarb-journal-'));
  const path = join(directory, 'ledger.local.json');
  try {
    await updateJournal(path, () => '{"pending":true}');
    await assert.rejects(updateJournal(path, () => { throw Error('interrupted'); }));
    assert.equal(await readFile(path, 'utf8'), '{"pending":true}');
    await assert.rejects(updateJournal(path, () => '{}'), { code: 'EEXIST' });
    await assert.rejects(updateJournal('relative.local.json', () => '{}'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Durable, single-writer storage for serialized paper ledgers. The reducer is
 * local bookkeeping only; never perform a network send inside it. An interrupted
 * writer leaves a lock and therefore stops progress rather than replaying a leg.
 */
export async function updateJournal(path, reduce, initial = null) {
  if (!isAbsolute(path) || !path.endsWith('.local.json')) {
    throw new Error('journal requires an absolute *.local.json path');
  }
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    let previous;
    try { previous = await readFile(path, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      previous = initial;
    }
    const next = await reduce(previous);
    if (typeof next !== 'string') throw new Error('journal reducer must return serialized JSON');
    JSON.parse(next);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(next); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); }
    finally { await directory.close(); }
    committed = true;
    return next;
  } finally {
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    await lock.close();
    // On any ambiguous write failure leave the lock for reconciliation. A
    // restart must not turn an uncertain result into a second submission.
    if (committed) await unlink(lockPath);
  }
}

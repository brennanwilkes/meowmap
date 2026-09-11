// The frontend and the Worker declare the same vocabularies in two files, because there
// is no bundler to share one declaration between buildless ES modules and TypeScript.
// Duplicated derivations drift, so this reads both and asserts they agree.
//   node tests/vocab.test.mjs
//
// The failure this prevents is quiet and late: a chip the Worker does not recognise is
// a 400 at save time, after the photo has already been processed.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  COAT_TAGS, MAX_NAME_LEN, MAX_NOTE_LEN, PETTED_VALUES, SIZE_TAGS,
} from '../frontend/config.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const src = readFileSync(new URL('../worker/src/constants.ts', import.meta.url), 'utf8');

function workerList(name) {
  const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
  assert.notStrictEqual(m, null, `${name} not found in worker/src/constants.ts`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s !== '');
}

function workerNumber(name) {
  const m = src.match(new RegExp(`export const ${name} = (\\d+)`));
  assert.notStrictEqual(m, null, `${name} not found in worker/src/constants.ts`);
  return Number(m[1]);
}

check('COAT_TAGS match the Worker, in the same order', () => {
  // Order matters as well as membership: it is the order the chips render in.
  assert.deepStrictEqual(COAT_TAGS, workerList('COAT_TAGS'));
});

check('SIZE_TAGS match the Worker', () => {
  assert.deepStrictEqual(SIZE_TAGS, workerList('SIZE_TAGS'));
});

check('PETTED_VALUES match the Worker', () => {
  assert.deepStrictEqual(PETTED_VALUES, workerList('PETTED_VALUES'));
});

check('the text length caps match the Worker', () => {
  // A client cap looser than the server's turns a typed-out note into a 400.
  assert.strictEqual(MAX_NOTE_LEN, workerNumber('MAX_NOTE_LEN'));
  assert.strictEqual(MAX_NAME_LEN, workerNumber('MAX_NAME_LEN'));
});

console.log(`vocab: ${pass} checks passed`);

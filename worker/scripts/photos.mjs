/**
 * Page through every photo in the database, one at a time, and delete the ones you do
 * not want.
 *
 *   node scripts/photos.mjs
 *
 * Keys: n/enter next · p previous · o open in browser · d delete · q quit
 *
 * Deletion here is REAL and immediate — rows and R2 objects, same reachability rule as
 * purge.mjs — so it asks for a typed y first. It is the one place in this repo where a
 * single keystroke is one step from destroying a photograph, and the confirmation is
 * what keeps a mis-tap from being the last thing that happens to it.
 */

import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { API_BASE, d1, deviceName, PREFIX, r2Delete } from './cf.mjs';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

function load() {
  return d1(`SELECT s.id, s.client_id, s.cat_id, s.device_id, s.lat, s.lon,
                    s.location_source, s.accuracy_m, s.seen_at, s.coat, s.size, s.petted,
                    s.note, s.photo_full, s.photo_thumb, s.photo_w, s.photo_h,
                    s.created_at, c.name AS cat_name
             FROM sightings s LEFT JOIN cats c ON c.id = s.cat_id
             ORDER BY s.seen_at DESC`);
}

function show(s, i, total) {
  const when = new Date(s.seen_at).toISOString().replace('T', ' ').slice(0, 19);
  const added = new Date(s.created_at).toISOString().replace('T', ' ').slice(0, 19);
  // cat_id can legitimately be 0, so this checks null rather than falsiness.
  const cat = s.cat_id === null || s.cat_id === undefined
    ? 'not identified'
    : `${s.cat_name ?? 'unnamed'} (#${s.cat_id})`;
  const acc = s.accuracy_m === null ? '' : ` ±${s.accuracy_m}m`;
  const tags = [s.coat, s.size, s.petted].filter((x) => x !== null && x !== '').join(' · ');

  console.clear();
  console.log(`┌─ sighting ${s.id}  (${i + 1} of ${total}) ${'─'.repeat(30)}`);
  console.log(`│ cat        ${cat}`);
  console.log(`│ seen       ${when} UTC`);
  console.log(`│ uploaded   ${added} UTC`);
  console.log(`│ device     ${deviceName(s.device_id)}`);
  console.log(`│ where      ${s.lat.toFixed(6)}, ${s.lon.toFixed(6)}  (${s.location_source}${acc})`);
  console.log(`│ map        https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=18/${s.lat}/${s.lon}`);
  if (tags !== '') console.log(`│ tags       ${tags}`);
  if (s.note !== null && s.note !== '') console.log(`│ note       ${s.note}`);
  console.log(`│ size       ${s.photo_w}x${s.photo_h}`);
  console.log(`│ photo      ${API_BASE}/photo/${s.photo_full}`);
  console.log(`│ clientId   ${s.client_id}`);
  console.log(`└${'─'.repeat(50)}`);
  console.log('\n  n next · p prev · o open · d delete · q quit');
}

function openInBrowser(url) {
  // xdg-open is the Linux answer; failing loudly beats pretending it worked.
  execFile('xdg-open', [url], (err) => {
    if (err !== null) console.error(`\nCould not open a browser: ${err.message}\n${url}`);
  });
}

async function remove(s) {
  const answer = await ask(`\nDelete sighting ${s.id} and its photos? This cannot be undone. [y/N] `);
  if (answer.trim().toLowerCase() !== 'y') return false;

  d1(`DELETE FROM sightings WHERE id = ${s.id}`);
  d1(`UPDATE app_meta SET data_version = data_version + 1, updated_at = ${Date.now()} WHERE id = 1`);

  // Same rule as purge.mjs: content-addressed keys can be shared, so only delete an
  // object no surviving row still points at.
  const still = new Set(
    d1('SELECT photo_full AS k FROM sightings UNION SELECT photo_thumb FROM sightings')
      .map((r) => r.k),
  );
  let freed = 0;
  for (const hash of [s.photo_full, s.photo_thumb]) {
    if (typeof hash !== 'string' || still.has(hash)) continue;
    r2Delete(`${PREFIX}${hash}`);
    freed++;
  }
  if (freed > 0) {
    d1(`UPDATE app_meta SET r2_objects = MAX(0, r2_objects - ${freed}), ` +
       `updated_at = ${Date.now()} WHERE id = 1`);
  }
  console.log(`Deleted sighting ${s.id} and ${freed} photo object(s).`);
  await ask('press enter…');
  return true;
}

async function main() {
  let rows = load();
  if (rows.length === 0) {
    console.log('No sightings in the database.');
    rl.close();
    return;
  }

  let i = 0;
  for (;;) {
    if (rows.length === 0) { console.log('\nNothing left.'); break; }
    if (i >= rows.length) i = rows.length - 1;
    if (i < 0) i = 0;

    show(rows[i], i, rows.length);
    const key = (await ask('> ')).trim().toLowerCase();

    if (key === 'q') break;
    if (key === 'o') { openInBrowser(`${API_BASE}/photo/${rows[i].photo_full}`); continue; }
    if (key === 'p') { i--; continue; }
    if (key === 'd') {
      if (await remove(rows[i])) { rows = load(); }
      continue;
    }
    i++;                       // n, enter, or anything else
    if (i >= rows.length) {
      console.log('\nThat was the last one.');
      i = rows.length - 1;
      await ask('press enter…');
    }
  }
  rl.close();
}

main();

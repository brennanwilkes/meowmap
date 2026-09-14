// The terminal UI primitives. Everything here is pure string work, which is exactly
// where a hand-rolled TUI goes wrong: a box drawn around coloured text comes out ragged
// because the escape sequences were counted as visible characters.
import { test } from 'node:test';
import assert from 'node:assert';
import { box, c, pad, paint, truncate, width } from '../scripts/tui.mjs';

test('width ignores ANSI escapes', () => {
  assert.strictEqual(width('hello'), 5);
  assert.strictEqual(width(paint('hello', c.red)), 5);
  assert.strictEqual(width(`${c.bold}${c.red}hi${c.reset}`), 2);
});

test('pad measures visible width, not byte length', () => {
  assert.strictEqual(width(pad(paint('hi', c.red), 10)), 10);
  assert.strictEqual(width(pad('already long enough', 3)), 19, 'never truncates');
});

test('truncate leaves room for the ellipsis', () => {
  assert.strictEqual(truncate('abcdefgh', 4), 'abc…');
  assert.strictEqual(truncate('abc', 10), 'abc');
});

test('box lines are all the same visible width, coloured content included', () => {
  const lines = box(['short', paint('coloured', c.green), 'a much longer line here'], {
    title: 'title',
    inner: 30,
  });
  const widths = new Set(lines.map(width));
  assert.strictEqual(widths.size, 1, `ragged box: ${[...widths].join(', ')}`);
});

test('a box sizes itself to its content when no width is given', () => {
  const lines = box(['abc'], {});
  assert.ok(width(lines[0]) >= 5);
  assert.strictEqual(new Set(lines.map(width)).size, 1);
});

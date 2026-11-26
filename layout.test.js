const test = require('node:test');
const assert = require('node:assert');
const { leaves, preset, kindOf, append, insert, map } = require('./renderer/layout.mjs');

// Panes are plain strings here; the tree never looks inside one. shape() writes a tree as h(a,b) / v(a,b).
const shape = (n) => (!n ? '' : n.pane ? n.pane : `${n.dir}(${n.children.map(shape).join()})`);
const without = (n, p) => map(n, (x) => x !== p && x);

test('toolbar layouts: a row, a column, and a grid with rows of equal length', () => {
  const p = [...'abcdefgh'];
  assert.strictEqual(shape(preset(p.slice(0, 1), 'grid')), 'a');
  assert.strictEqual(shape(preset(p.slice(0, 3), 'h')), 'h(a,b,c)');
  assert.strictEqual(shape(preset(p.slice(0, 3), 'v')), 'v(a,b,c)');
  assert.strictEqual(shape(preset(p.slice(0, 2), 'grid')), 'h(a,b)');
  assert.strictEqual(shape(preset(p.slice(0, 4), 'grid')), 'v(h(a,b),h(c,d))');
  assert.strictEqual(shape(preset(p.slice(0, 5), 'grid')), 'v(h(a,b,c),h(d,e))');
  assert.strictEqual(shape(preset(p, 'grid')), 'v(h(a,b,c),h(d,e,f),h(g,h))');
  assert.deepStrictEqual(leaves(preset(p, 'grid')), p);
  assert.strictEqual(preset([], 'h'), null);
});

test('kindOf names the shape, whatever the sizes, and a grid that lost a pane is no longer one', () => {
  const p = [...'abcdefgh'];
  for (const l of ['h', 'v', 'grid']) assert.strictEqual(kindOf(preset(p, l)), l);
  assert.strictEqual(kindOf(null), 'h');
  assert.strictEqual(kindOf(preset(['a'], 'v')), 'h');
  assert.strictEqual(kindOf(preset(['a', 'b'], 'grid')), 'h'); // a grid of two is a row
  const grid = preset(p.slice(0, 4), 'grid');
  grid.sizes = [3, 1];
  assert.strictEqual(kindOf(grid), 'grid');
  assert.strictEqual(kindOf(without(grid, 'b')), 'custom'); // v(a,h(c,d))
  assert.strictEqual(kindOf(without(grid, 'd')), 'grid'); // v(h(a,b),c): what a grid of three is
  assert.strictEqual(kindOf(insert(preset(['a', 'b'], 'h'), 'c', 'b', 'v')), 'custom');
  assert.strictEqual(kindOf(insert(preset(['a', 'b'], 'h'), 'c', 'b', 'h')), 'h');
});

test('append adds to the end of a row or column and keeps dragged sizes', () => {
  const col = preset(['a', 'b'], 'v');
  col.sizes = [1.5, 0.5];
  const t = append(col, 'c', 'v');
  assert.strictEqual(shape(t), 'v(a,b,c)');
  assert.deepStrictEqual(t.sizes, [1.5, 0.5, 1]);
  assert.strictEqual(shape(append(null, 'a', 'h')), 'a');
  assert.strictEqual(shape(append({ pane: 'a' }, 'b', 'h')), 'h(a,b)');
});

test('splitting a pane nests a split, or adds a sibling when the direction already matches', () => {
  let t = preset(['a', 'b'], 'h');
  t = insert(t, 'c', 'b', 'v');
  assert.strictEqual(shape(t), 'h(a,v(b,c))');
  t = insert(t, 'd', 'c', 'h');
  assert.strictEqual(shape(t), 'h(a,v(b,h(c,d)))');
  t = insert(t, 'e', 'a', 'h'); // same direction as a's split: a sibling that takes half of a's share
  assert.strictEqual(shape(t), 'h(a,e,v(b,h(c,d)))');
  assert.deepStrictEqual(t.sizes, [0.5, 0.5, 1]);
  assert.deepStrictEqual(leaves(t), ['a', 'e', 'b', 'c', 'd']);
  assert.strictEqual(shape(insert({ pane: 'a' }, 'b', 'a', 'v')), 'v(a,b)');
});

test('closing a pane collapses a split left with one child, and the others keep their sizes', () => {
  let t = insert(insert(preset(['a', 'b'], 'h'), 'c', 'b', 'v'), 'd', 'c', 'h'); // h(a,v(b,h(c,d)))
  t.sizes = [3, 1];
  t = without(t, 'd');
  assert.strictEqual(shape(t), 'h(a,v(b,c))');
  t = without(t, 'b');
  assert.strictEqual(shape(t), 'h(a,c)');
  assert.deepStrictEqual(t.sizes, [3, 1]);
  assert.strictEqual(shape(without(t, 'a')), 'c');
  assert.strictEqual(without(without(t, 'a'), 'c'), null);
});

test('duplicating keeps the shape and sizes, minus panes that could not be reopened', () => {
  const t = insert(preset(['a', 'b', 'c'], 'h'), 'd', 'b', 'v'); // h(a,v(b,d),c)
  t.sizes = [1, 2, 3];
  const twin = new Map([['a', 'A'], ['b', 'B'], ['c', 'C']]); // d's connection was deleted
  const t2 = map(t, (p) => twin.get(p));
  assert.strictEqual(shape(t2), 'h(A,B,C)');
  assert.deepStrictEqual(t2.sizes, [1, 2, 3]);
  assert.notStrictEqual(t2.sizes, t.sizes); // a copy: resizing one tab must not resize the other
});

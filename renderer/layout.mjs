// A tab's layout is a tree. A leaf is { pane } (one session). A split is
// { dir: 'h' | 'v', children: [node, node, ...], sizes: [...] }: its children side by side ('h') or
// stacked ('v'), each with its share of the space (a flex-grow number) in `sizes`.
// No DOM in here: app.js draws the tree, layout.test.js checks these functions.

// Every pane in the tree, in reading order.
export const leaves = (n) => (!n ? [] : n.pane ? [n.pane] : n.children.flatMap(leaves));

const split = (dir, children) => (children.length === 1 ? children[0] : { dir, children, sizes: children.map(() => 1) });

// The toolbar layouts: 'h' is one row, 'v' one column, 'grid' rows of equal length (2×2 for four, 3+3+2 for eight).
export function preset(panes, layout) {
  const kids = panes.map((pane) => ({ pane }));
  if (!kids.length) return null;
  if (layout !== 'grid') return split(layout, kids);
  const cols = Math.ceil(Math.sqrt(kids.length)), rows = [];
  for (let i = 0; i < kids.length; i += cols) rows.push(split('h', kids.slice(i, i + cols)));
  return split('v', rows);
}

// What the tree looks like: the toolbar layout that would build exactly this shape, or 'custom'.
// Sizes do not count. One pane, or two side by side, is 'h' (a grid of two is the same shape).
const shape = (n) => (n.pane ? '.' : `${n.dir}(${n.children.map(shape)})`);
export const kindOf = (n) => (!n ? 'h' : ['h', 'v', 'grid'].find((l) => shape(preset(leaves(n), l)) === shape(n)) || 'custom');

// One more pane at the end of a row ('h') or column ('v'); the others keep their sizes.
export function append(n, pane, dir) {
  if (!n) return { pane };
  return n.dir === dir ? { dir, children: [...n.children, { pane }], sizes: [...n.sizes, 1] } : { dir, children: [n, { pane }], sizes: [1, 1] };
}

// Put `pane` to the right of ('h') or below ('v') the pane `beside`; the two share the space `beside` had.
export function insert(n, pane, beside, dir) {
  if (n.pane) return n.pane === beside ? { dir, children: [n, { pane }], sizes: [1, 1] } : n;
  const i = n.children.findIndex((c) => c.pane === beside);
  if (i < 0 || n.dir !== dir) return { ...n, children: n.children.map((c) => insert(c, pane, beside, dir)) };
  // Already in a split of that direction: one more child there, not a split inside a split.
  return { dir, children: n.children.toSpliced(i + 1, 0, { pane }), sizes: n.sizes.toSpliced(i, 1, n.sizes[i] / 2, n.sizes[i] / 2) };
}

// A copy of the tree with each pane swapped for f(pane). A pane f returns nothing for is left out,
// and a split left with one child becomes that child. Closing a pane and duplicating a tab are both this.
export function map(n, f) {
  if (!n) return null;
  if (n.pane) { const pane = f(n.pane); return pane ? { pane } : null; }
  const kids = n.children.map((c) => map(c, f)), children = kids.filter(Boolean);
  return children.length > 1 ? { dir: n.dir, children, sizes: n.sizes.filter((_, i) => kids[i]) } : children[0] || null;
}

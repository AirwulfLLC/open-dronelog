/**
 * Immutable update of a nested report field addressed by a dotted path
 * (`anomalies.2.finding`). Array segments are numeric indices.
 */
export function setPath<T>(root: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const assign = (node: unknown, i: number): unknown => {
    if (i === keys.length) return value;
    const key = keys[i];
    if (Array.isArray(node)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return node; // unknown index: leave untouched
      const copy = [...node];
      copy[idx] = assign(node[idx], i + 1);
      return copy;
    }
    const obj = node && typeof node === 'object' ? (node as Record<string, unknown>) : {};
    return { ...obj, [key]: assign(obj[key], i + 1) };
  };
  return assign(root, 0) as T;
}

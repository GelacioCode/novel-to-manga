export type LetteringBox = { x: number; y: number; width: number; height: number };

export function fitLetteringToPage<T extends LetteringBox>(items: T[], force = false): T[] {
  if (!items.length) return items;
  const outOfBounds = items.some(item => item.x < 0 || item.y < 0 || item.x + item.width > 100 || item.y + item.height > 96);
  if (!force && !outOfBounds) return items;

  const columns = items.length === 1 ? 1 : 2;
  const rows = Math.ceil(items.length / columns);
  const height = Math.max(9, Math.min(16, 82 / rows));
  const yStep = rows > 1 ? (88 - height) / (rows - 1) : 0;

  return items.map((item, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    return {
      ...item,
      x: columns === 1 ? 24 : column === 0 ? 54 : 6,
      y: 5 + row * yStep,
      width: columns === 1 ? 52 : 40,
      height
    };
  });
}

/** Bounded-parallelism map. Preserves input order in the result. */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) return [];
  const effective = Math.max(1, Math.min(limit, items.length));
  const results: R[] = Array.from({ length: items.length });
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: effective }, () => worker()));
  return results;
};

export const DEFAULT_CONCURRENCY = 6;

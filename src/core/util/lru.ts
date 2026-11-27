/** A least-recently-used cache bounded by the total "weight" of its values. */
export class LruCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;

  public constructor(
    private readonly maxWeight: number,
    private readonly weigh: (value: V) => number = () => 1,
  ) {}

  public get size(): number {
    return this.entries.size;
  }

  public get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.value;
  }

  public set(key: K, value: V): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.totalWeight -= existing.weight;
      this.entries.delete(key);
    }
    const weight = this.weigh(value);
    if (weight > this.maxWeight) {
      return;
    }
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    for (const [oldKey, entry] of this.entries) {
      if (this.totalWeight <= this.maxWeight) {
        break;
      }
      this.entries.delete(oldKey);
      this.totalWeight -= entry.weight;
    }
  }

  public clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }
}

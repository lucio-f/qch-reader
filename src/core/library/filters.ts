import type { AttributeSet, QchFile } from '../qch/qchFile';

/**
 * A documentation filter. Combines Qt's two filtering models:
 * - the modern filter engine (Qt ≥ 5.13): documents are selected by component (virtual
 *   folder) and version;
 * - legacy filter attributes: every item (page, keyword, contents section) must carry all of
 *   the filter's attributes.
 * Empty lists do not restrict anything.
 */
export interface DocumentFilter {
  readonly id: string;
  readonly label: string;
  readonly components: readonly string[];
  readonly versions: readonly string[];
  readonly attributes: readonly string[];
}

export const NO_FILTER: DocumentFilter = {
  id: 'all',
  label: 'All Documentation',
  components: [],
  versions: [],
  attributes: [],
};

export function isNoFilter(filter: DocumentFilter): boolean {
  return (
    filter.components.length === 0 && filter.versions.length === 0 && filter.attributes.length === 0
  );
}

/** Evaluates a {@link DocumentFilter} with per-set memoization. */
export class FilterMatcher {
  private readonly components: ReadonlySet<string>;
  private readonly versions: ReadonlySet<string>;
  private readonly itemCache = new WeakMap<AttributeSet, boolean>();
  private readonly documentCache = new WeakMap<QchFile, boolean>();

  public constructor(public readonly filter: DocumentFilter) {
    this.components = new Set(filter.components.map((c) => c.toLowerCase()));
    this.versions = new Set(filter.versions);
  }

  public get isEmpty(): boolean {
    return isNoFilter(this.filter);
  }

  public matchesDocument(file: QchFile): boolean {
    let result = this.documentCache.get(file);
    if (result === undefined) {
      result =
        (this.components.size === 0 ||
          file.folders.some((folder) => this.components.has(folder.toLowerCase()))) &&
        (this.versions.size === 0 || this.versions.has(file.version)) &&
        this.filter.attributes.every((attribute) => file.filterAttributes.includes(attribute));
      this.documentCache.set(file, result);
    }
    return result;
  }

  public matchesItem(attributes: AttributeSet): boolean {
    if (this.filter.attributes.length === 0) {
      return true;
    }
    let result = this.itemCache.get(attributes);
    if (result === undefined) {
      result = this.filter.attributes.every((attribute) => attributes.has(attribute));
      this.itemCache.set(attributes, result);
    }
    return result;
  }
}

export const ALL_MATCHER = new FilterMatcher(NO_FILTER);

/** Filters declared by the documentation itself (`<customFilter>` in the .qhp project). */
export function collectDeclaredFilters(files: readonly QchFile[]): DocumentFilter[] {
  const byName = new Map<string, DocumentFilter>();
  for (const file of files) {
    for (const custom of file.customFilters) {
      if (!byName.has(custom.name)) {
        byName.set(custom.name, {
          id: `declared:${custom.name}`,
          label: custom.name,
          components: [],
          versions: [],
          attributes: custom.attributes,
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Compares dotted version strings numerically (`5.15.2` < `6.4.0`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    const diff =
      Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== ''
        ? nx - ny
        : x.localeCompare(y);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

// Messages exchanged between the extension host and its webviews. This module is compiled
// for both environments, so it must stay free of Node, DOM and VS Code dependencies.

export type Appearance = 'themed' | 'original';
export type SearchMode = 'fulltext' | 'index';

export interface TextSegment {
  readonly text: string;
  readonly match: boolean;
}

export interface HighlightTerm {
  readonly term: string;
  readonly prefix: boolean;
}

export interface Breadcrumb {
  readonly title: string;
  readonly url: string;
}

export interface NavigationState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Persisted webview state (used to restore panels after a reload). */
export interface DocViewState {
  readonly url?: string;
  readonly scrollY?: number;
}

export type DocViewToWebview =
  | {
      readonly type: 'page';
      readonly url: string;
      readonly title: string;
      readonly documentTitle: string;
      readonly html: string;
      readonly fragment: string;
      readonly scrollY: number | undefined;
      readonly highlights: readonly HighlightTerm[];
      readonly breadcrumbs: readonly Breadcrumb[];
      readonly navigation: NavigationState;
      readonly appearance: Appearance;
    }
  | {
      readonly type: 'notFound';
      readonly url: string;
      readonly message: string;
      readonly navigation: NavigationState;
    }
  | { readonly type: 'loading' }
  | { readonly type: 'scrollTo'; readonly fragment: string; readonly scrollY: number | undefined }
  | { readonly type: 'navigation'; readonly url: string; readonly navigation: NavigationState }
  | { readonly type: 'settings'; readonly zoom: number; readonly appearance: Appearance }
  | { readonly type: 'find' }
  | { readonly type: 'clearHighlights' };

export type DocViewFromWebview =
  | { readonly type: 'ready' }
  | {
      readonly type: 'navigate';
      readonly href: string;
      readonly newTab: boolean;
      readonly side: boolean;
    }
  | { readonly type: 'openExternal'; readonly href: string }
  | { readonly type: 'fragment'; readonly fragment: string }
  | { readonly type: 'back' }
  | { readonly type: 'forward' }
  | { readonly type: 'home' }
  | { readonly type: 'scroll'; readonly scrollY: number }
  | { readonly type: 'syncContents' }
  | { readonly type: 'copyUrl'; readonly href: string | undefined }
  | { readonly type: 'toggleAppearance' }
  | { readonly type: 'zoom'; readonly zoom: number }
  | { readonly type: 'focus'; readonly focused: boolean }
  | { readonly type: 'searchText'; readonly text: string };

export interface DocumentOption {
  readonly namespace: string;
  readonly title: string;
  readonly version: string;
}

export interface IndexStatus {
  readonly state: 'disabled' | 'idle' | 'building' | 'ready' | 'error';
  readonly done: number;
  readonly total: number;
  readonly message?: string;
}

export interface SearchResultItem {
  readonly url: string;
  readonly title: readonly TextSegment[];
  readonly subtitle: string;
  readonly detail: string;
  readonly snippet?: readonly TextSegment[];
}

export type SearchViewToWebview =
  | {
      readonly type: 'state';
      readonly documents: readonly DocumentOption[];
      readonly filterLabel: string;
      readonly filtered: boolean;
      readonly index: IndexStatus;
      readonly loading: boolean;
    }
  | {
      readonly type: 'results';
      readonly requestId: number;
      readonly mode: SearchMode;
      readonly items: readonly SearchResultItem[];
      readonly highlights: readonly HighlightTerm[];
      readonly total: number;
      readonly truncated: boolean;
      readonly elapsedMs: number;
      readonly append: boolean;
      readonly hasMore: boolean;
      readonly error?: string;
    }
  | {
      readonly type: 'setQuery';
      readonly query: string;
      readonly mode?: SearchMode;
      readonly scope?: string;
    };

export type SearchViewFromWebview =
  | { readonly type: 'ready' }
  | {
      readonly type: 'search';
      readonly requestId: number;
      readonly query: string;
      readonly mode: SearchMode;
      readonly scope: string;
      readonly offset: number;
    }
  | {
      readonly type: 'open';
      readonly url: string;
      readonly side: boolean;
      readonly highlights: readonly HighlightTerm[];
    }
  | { readonly type: 'selectFilter' }
  | { readonly type: 'buildIndex' }
  | { readonly type: 'addFolder' };

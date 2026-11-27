/** Anything with a `dispose` method (event emitters, status bar items, subscriptions…). */
export interface Disposable {
  dispose(): unknown;
}

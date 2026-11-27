export interface IndexWorkerRequest {
  readonly id: number;
  /** File system path of the .qch file to index. */
  readonly path: string;
}

export type IndexWorkerResponse =
  | {
      readonly id: number;
      readonly kind: 'progress';
      readonly done: number;
      readonly total: number;
    }
  | { readonly id: number; readonly kind: 'done'; readonly bytes: Uint8Array }
  | { readonly id: number; readonly kind: 'error'; readonly message: string };

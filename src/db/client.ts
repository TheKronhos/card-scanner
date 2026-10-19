import * as Comlink from 'comlink';
import type { Repo } from './repo';
import type { RefreshProgress, RefreshResult, WorkerApi } from './worker';

/** Where the data pack is published (public repo mtg-scanner-data, GitHub Pages). */
export const PACK_BASE: string =
  import.meta.env.VITE_PACK_BASE ?? (import.meta.env.DEV ? `${location.origin}/dev-pack/` : 'https://thekronhos.github.io/mtg-scanner-data/');

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const remote = Comlink.wrap<WorkerApi>(worker);

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never };

/** The Repo, running in the worker. Every method returns a Promise. */
export const db = new Proxy({} as Async<Repo>, {
  get: (_t, method: string) => (...args: unknown[]) => remote.call(method as never, args),
});

export const initDb = () => remote.init();

export function refreshCards(onProgress: (p: RefreshProgress) => void, force = false): Promise<RefreshResult> {
  return remote.refresh(PACK_BASE, Comlink.proxy(onProgress), force);
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

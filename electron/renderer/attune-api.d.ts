import type { AttuneApi } from '../preload';

declare global {
  interface Window {
    attune: AttuneApi;
  }
}

export {};

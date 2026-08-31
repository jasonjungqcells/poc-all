/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** Override the control-plane origin; empty when served by the rig itself. */
  readonly VITE_CONTROL_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Loads code review's diagram engine on demand (see ./diagramEngineContract).
 *
 * Nothing here runs until a Markdown preview or a guide overview renders a
 * diagram fence AND the server advertised the engine. Then, once per page:
 * the host object (the page's React and ui modules, the runtime URLs) goes on
 * `globalThis`, and the engine file is imported by URL. A failed import is
 * dropped from the memo, so the next fence that mounts (a view switch, a
 * Retry) tries again; until then fences show as code.
 *
 * The namespace imports below are what the engine uses instead of its own
 * copies. They name modules the page already carries, so they cost the page
 * only the export names they keep alive.
 */
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ThemeProviderModule from '@plannotator/ui/components/ThemeProvider';
import * as ConfigIndex from '@plannotator/ui/config';
import * as Identity from '@plannotator/ui/utils/identity';
import * as MathSlot from '@plannotator/ui/utils/math';
import {
  DIAGRAM_ENGINE_API_VERSION,
  DIAGRAM_ENGINE_HOST_KEY,
  type DiagramEngineHost,
  type DiagramEngineModule,
  type DiagramEngineSharedModule,
  type DiagramEngineUrls,
} from './diagramEngineContract';

export type DiagramEngineImporter = (url: string) => Promise<unknown>;

const importByUrl: DiagramEngineImporter = (url) => import(/* @vite-ignore */ url);

function sharedModules(): Record<DiagramEngineSharedModule, unknown> {
  return {
    react: React,
    'react/jsx-runtime': JsxRuntime,
    'react-dom': ReactDOM,
    'ui:components/ThemeProvider': ThemeProviderModule,
    'ui:config/index': ConfigIndex,
    'ui:utils/identity': Identity,
    'ui:utils/math': MathSlot,
  };
}

/** A same-origin absolute path, as the review server advertises them. */
const isServedPath = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\s\\]/.test(value);

/** The `/api/diff` advert, or null when absent or malformed (fences then show as code). */
export function parseDiagramEngineUrls(value: unknown): DiagramEngineUrls | null {
  if (!value || typeof value !== 'object') return null;
  const { engine, mermaid, graphviz } = value as Record<string, unknown>;
  if (!isServedPath(engine) || !isServedPath(mermaid) || !isServedPath(graphviz)) return null;
  return { engine, mermaid, graphviz };
}

function asEngine(value: unknown): DiagramEngineModule {
  const mod = value as Partial<DiagramEngineModule> | null;
  if (!mod || mod.apiVersion !== DIAGRAM_ENGINE_API_VERSION || typeof mod.DiagramFence !== 'function') {
    throw new Error('The diagram engine this server sent does not match this page.');
  }
  return mod as DiagramEngineModule;
}

let memo: { url: string; promise: Promise<DiagramEngineModule> } | null = null;
let loaded: { url: string; engine: DiagramEngineModule } | null = null;

/** The engine, if it already loaded from these URLs (so a fence mounted
 * after the load renders it on its first render, with no code flash). */
export function peekDiagramEngine(urls: DiagramEngineUrls): DiagramEngineModule | null {
  return loaded && loaded.url === urls.engine ? loaded.engine : null;
}

/** Import the engine once; concurrent and later callers share the import. */
export function loadDiagramEngine(urls: DiagramEngineUrls, importer: DiagramEngineImporter = importByUrl): Promise<DiagramEngineModule> {
  if (memo && memo.url === urls.engine) return memo.promise;
  const host: DiagramEngineHost = {
    apiVersion: DIAGRAM_ENGINE_API_VERSION,
    modules: sharedModules(),
    runtimeUrls: { mermaid: urls.mermaid, graphviz: urls.graphviz },
  };
  (globalThis as Record<string, unknown>)[DIAGRAM_ENGINE_HOST_KEY] = host;
  const promise = importer(urls.engine).then(asEngine);
  const entry = { url: urls.engine, promise };
  memo = entry;
  promise.then(
    (engine) => {
      if (memo === entry) loaded = { url: urls.engine, engine };
    },
    () => {
      if (memo === entry) memo = null;
    },
  );
  return promise;
}

/** Test hook: forget the engine and the host. */
export function __resetDiagramEngineForTests(): void {
  memo = null;
  loaded = null;
  delete (globalThis as Record<string, unknown>)[DIAGRAM_ENGINE_HOST_KEY];
}

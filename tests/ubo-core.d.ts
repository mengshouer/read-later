/**
 * `@gorhill/ubo-core` ships no types. Declared here rather than pulled in as a dependency,
 * because only `tests/ubo-differential.test.ts` and `scripts/filter-probe.mjs` touch it — it is
 * GPL-3.0 against this project's MIT, so it stays a devDependency and never reaches `.output/`.
 *
 * Only the surface those two use is described. `filterQuery` is the whole reason it is here: it
 * returns the URL uBO would have redirected the request to, which is how "what does uBO keep?"
 * is read back out of the real engine.
 */
declare module '@gorhill/ubo-core' {
  export interface UboFilterQueryDetails {
    url: string;
    type: string;
    originURL: string;
  }

  export interface UboFilterQueryResult {
    /** Present only when at least one `$removeparam` actually changed the URL. */
    redirectURL?: string;
    directives?: unknown[];
  }

  export class StaticNetFilteringEngine {
    static create(options?: Record<string, unknown>): Promise<StaticNetFilteringEngine>;
    useLists(lists: Array<{ name: string; raw: string }>): Promise<unknown>;
    filterQuery(details: UboFilterQueryDetails): UboFilterQueryResult | null;
  }
}

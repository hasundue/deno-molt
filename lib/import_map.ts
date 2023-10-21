import { maxBy } from "./std/collections.ts";
import { parse as parseJsonc } from "./std/jsonc.ts";
import { type ImportMapJson, parseFromJson } from "./x/import_map.ts";
import { is } from "./x/unknownutil.ts";
import type { Maybe } from "./types.ts";
import { URI } from "./uri.ts";
import { URIScheme } from "./types.ts";

export type { ImportMapJson };

export interface ImportMapResolveResult {
  /** The full specifier resolved from the import map. */
  specifier: URI<URIScheme>;
  from?: string;
  to?: string;
}

export interface ImportMap {
  // TODO: Accept a remote URL
  specifier: URI<"file">;
  resolve(specifier: string, referrer: string): Maybe<ImportMapResolveResult>;
  resolveSimple(specifier: string, referrer: string): string;
}

export const ImportMap = {
  readFromJson,
};

const isImportMapJson = is.ObjectOf({
  imports: is.RecordOf(is.String),
});

const isImportMapReferrer = is.ObjectOf({
  importMap: is.String,
});

// This implementation is ridiculously inefficient, but we prefer not to reimplement the whole
// import_map module. Maybe we should rathre patch rust code of the import_map module.
async function readFromJson(url: URL): Promise<Maybe<ImportMap>> {
  const data = await Deno.readTextFile(url.pathname);
  if (data.length === 0) return;
  const json = parseJsonc(data);
  if (isImportMapReferrer(json)) {
    // The json seems to be deno.json or deno.jsonc referencing an import map.
    return readFromJson(new URL(json.importMap, url));
  }
  if (!isImportMapJson(json)) {
    // The json does not include an import map.
    return undefined;
  }
  const inner = await parseFromJson(url, json);
  return {
    specifier: URI.from(url.href),
    resolve(specifier, referrer) {
      const resolved = inner.resolve(specifier, referrer);
      if (resolved === specifier) {
        // The specifier is not resolved by the import map.
        return undefined;
      }
      // Find which key is used for the resolution.
      const replacement = maxBy(
        Object.entries(json.imports)
          .map(([from, to]) => ({ from, to }))
          .filter(({ to }) => resolved.includes(to)),
        ({ to }) => to.length,
      );
      if (!replacement) {
        // The specifier should be a file path
        URI.ensure("file")(resolved);
      }
      return {
        specifier: URI.ensure(...URIScheme.values)(resolved),
        ...replacement,
      };
    },
    resolveSimple: inner.resolve.bind(inner),
  };
}

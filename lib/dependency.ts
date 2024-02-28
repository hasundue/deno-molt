import { filterEntries } from "./std/collections.ts";
import { assertExists } from "./std/assert.ts";
import * as SemVer from "./std/semver.ts";
import { Mutex } from "./x/async.ts";
import { ensure, is } from "./x/unknownutil.ts";

/**
 * Properties of a dependency parsed from an import specifier.
 */
export interface Dependency {
  /**
   * The URL protocol of the dependency.
   * @example
   * ```ts
   * const { protocol } = Dependency.parse(
   *   new URL("https://deno.land/std/fs/mod.ts")
   * );
   * // -> "https:"
   */
  protocol: string;
  /**
   * The name of the dependency.
   * @example
   * ```ts
   * const { name } = Dependency.parse(
   *   new URL("https://deno.land/std@0.205.0/fs/mod.ts")
   * );
   * // -> "deno.land/std"
   * ```
   */
  name: string;
  /**
   * The version string of the dependency.
   * @example
   * ```ts
   * const { version } = Dependency.parse(
   *   new URL("https://deno.land/std@0.205.0/fs/mod.ts")
   * );
   * // -> "0.205.0"
   * ```
   */
  version?: string;
  /**
   * The subpath of the dependency.
   * @example
   * ```ts
   * const { path } = Dependency.parse(
   *   new URL("https://deno.land/std@0.205.0/fs/mod.ts")
   * );
   * // -> "/fs/mod.ts"
   *
   * const { path } = Dependency.parse(
   *   new URL("npm:node-emoji@2.0.0")
   * );
   * // -> ""
   * ```
   */
  path: string;
}

/**
 * Properties of a dependency parsed from an updated import specifier.
 * The `version` property is guaranteed to be present.
 */
export interface UpdatedDependency extends Dependency {
  version: string;
}

/**
 * Parse properties of a dependency from the given URL.
 * @example
 * ```ts
 * const { name, version, path } = Dependency.parse(
 *   new URL("https://deno.land/std@0.200.0/fs/mod.ts")
 * );
 * // -> { name: "deno.land/std", version: "0.200.0", path: "/fs/mod.ts" }
 * ```
 */
export function parse(url: string | URL): Dependency {
  url = new URL(url);
  const protocol = url.protocol;
  const body = url.hostname + url.pathname;

  // Try to find a path segment like "<name>@<version>/"
  const matched = body.match(
    /^(?<name>.+)@(?<version>[^/]+)(?<path>\/.*)?$/,
  );

  if (matched) {
    assertExists(matched.groups);
    const { name, version } = matched.groups;
    const path = matched.groups.path ?? "";
    return { protocol, name, version, path };
  }

  return { protocol, name: body, path: "" };
}

/**
 * Convert the given protocol to a URL scheme.
 */
function addSeparator(protocol: string): string {
  switch (protocol) {
    case "file:":
    case "http:":
    case "https:":
      return protocol + "//";
    default:
      return protocol;
  }
}

/**
 * Convert the given dependency to a URL string.
 * @example
 * ```ts
 * const uri = toURL({
 *   protocol: "https:",
 *   name: "deno.land/std",
 *   version: "1.0.0",
 *   path: "/fs/mod.ts",
 * });
 * // -> "https://deno.land/std@1.0.0/fs/mod.ts"
 * ```
 */
export function toUrl(dependency: Dependency): string {
  const header = addSeparator(dependency.protocol);
  const version = dependency.version ? "@" + dependency.version : "";
  const path = dependency.path;
  return `${header}${dependency.name}${version}${path}`;
}

/**
 * Resolve the latest version of the given dependency.
 *
 * @returns The latest version of the given dependency, or `undefined` if the
 * latest version of dependency is unable to resolve.
 *
 * @throws An error if the dependency is not found in the registry.
 *
 * @example
 * ```ts
 * await Dependency.resolveLatestVersion(
 *   Dependency.parse(new URL("https://deno.land/std@0.200.0/fs/mod.ts"))
 * );
 * // -> { name: "deno.land/std", version: "0.207.0", path: "/fs/mod.ts" }
 * ```
 */
export async function resolveLatestVersion(
  dependency: Dependency,
): Promise<UpdatedDependency | undefined> {
  await LatestVersionCache.lock(dependency.name);
  const result = await _resolveLatestVersion(dependency);
  LatestVersionCache.unlock(dependency.name);
  return result;
}

class LatestVersionCache {
  static #mutex = new Map<string, Mutex>();
  static #cache = new Map<string, UpdatedDependency | null>();

  static lock(name: string): Promise<void> {
    const mutex = this.#mutex.get(name) ??
      this.#mutex.set(name, new Mutex()).get(name)!;
    return mutex.acquire();
  }

  static unlock(name: string): void {
    const mutex = this.#mutex.get(name);
    assertExists(mutex);
    mutex.release();
  }

  static get(name: string): UpdatedDependency | null | undefined {
    return this.#cache.get(name);
  }

  static set<T extends UpdatedDependency | null>(
    name: string,
    dependency: T,
  ): T {
    this.#cache.set(name, dependency);
    return dependency;
  }
}

async function _resolveLatestVersion(
  dependency: Dependency,
): Promise<UpdatedDependency | undefined> {
  const cached = LatestVersionCache.get(dependency.name);
  if (cached) {
    return { ...cached, path: dependency.path };
  }
  if (cached === null) {
    // The dependency is already found to be up to date or unable to resolve.
    return;
  }
  const constraint = dependency.version
    ? SemVer.tryParseRange(dependency.version)
    : undefined;

  // Do not update inequality ranges.
  if (constraint && constraint.flat().length > 1) {
    return;
  }

  switch (dependency.protocol) {
    case "npm:": {
      const response = await fetch(
        `https://registry.npmjs.org/${dependency.name}`,
      );
      if (!response.ok) {
        break;
      }
      const pkg = ensure(
        await response.json(),
        isNpmPackageMeta,
        { message: `Invalid response from NPM registry: ${response.url}` },
      );
      const latest = pkg["dist-tags"].latest;
      if (latest === dependency.version || isPreRelease(latest)) {
        break;
      }
      return LatestVersionCache.set(
        dependency.name,
        { ...dependency, version: latest },
      );
    }
    // Ref: https://jsr.io/docs/api#jsr-registry-api
    case "jsr:": {
      const response = await fetch(
        `https://jsr.io/${dependency.name}/meta.json`,
      );
      if (!response.ok) {
        break;
      }
      const meta = ensure(
        await response.json(),
        isJsrPackageMeta,
        { message: `Invalid response from JSR registry: ${response.url}` },
      );
      const candidates = filterEntries(
        meta.versions,
        ([version, { yanked }]) => !yanked && !isPreRelease(version),
      );
      const semvers = Object.keys(candidates).map(SemVer.parse);
      const latest = SemVer.format(semvers.sort(SemVer.compare).reverse()[0]);
      if (latest === dependency.version || isPreRelease(latest)) {
        break;
      }
      return LatestVersionCache.set(
        dependency.name,
        { ...dependency, version: latest },
      );
    }
    case "http:":
    case "https:": {
      const response = await fetch(
        addSeparator(dependency.protocol) + dependency.name + dependency.path,
        { method: "HEAD" },
      );
      await response.arrayBuffer();
      if (!response.redirected) {
        break;
      }
      const latest = parse(response.url);
      if (!latest.version || isPreRelease(latest.version)) {
        break;
      }
      return LatestVersionCache.set(
        dependency.name,
        latest as UpdatedDependency,
      );
    }
  }
  LatestVersionCache.set(dependency.name, null);
}

const isNpmPackageMeta = is.ObjectOf({
  "dist-tags": is.ObjectOf({
    latest: is.String,
  }),
});

const isJsrPackageMeta = is.ObjectOf({
  versions: is.RecordOf(
    is.ObjectOf({
      yanked: is.OptionalOf(is.Boolean),
    }),
    is.String,
  ),
});

/**
 * Check if the given version string represents a pre-release.
 *
 * @example
 * ```ts
 * isPreRelease("0.1.0"); // -> false
 * isPreRelease("0.1.0-alpha.1"); // -> true
 * ```
 */
export function isPreRelease(version: string): boolean {
  const parsed = SemVer.tryParse(version);
  return parsed !== undefined && parsed.prerelease !== undefined &&
    parsed.prerelease.length > 0;
}

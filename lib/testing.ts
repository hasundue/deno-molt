import {
  assertSpyCall,
  assertSpyCallArg,
  ConstructorSpy,
  createAssertSnapshot,
  ExpectedSpyCall,
  Spy,
  spy,
  Stub,
  stub,
} from "./std/testing.ts";
import { AssertionError } from "./std/assert.ts";
import { EOL, formatEOL } from "./std/fs.ts";
import { fromFileUrl } from "./std/path.ts";
import { URI } from "./uri.ts";
import { SemVerString } from "./semver.ts";

export const assertSnapshot = createAssertSnapshot({
  dir: fromFileUrl(new URL("../test/snapshots/", import.meta.url)),
});

export function createCommandStub(): ConstructorSpy<
  Deno.Command,
  ConstructorParameters<typeof Deno.Command>
> {
  const CommandSpy = spy(Deno.Command);
  return class extends CommandSpy {
    #output: Deno.CommandOutput = {
      code: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      success: true,
      signal: null,
    };
    outputSync() {
      return this.#output;
    }
    output() {
      return Promise.resolve(this.#output);
    }
    spawn() {
      return new Deno.ChildProcess();
    }
    static clear() {
      this.calls = [];
    }
  };
}

export class FileSystemFake extends Map<URI<"file">, string> {}

export const ReadTextFileStub = {
  create(
    fs: FileSystemFake,
    options?: {
      readThrough?: boolean;
    },
  ): Stub {
    const original = Deno.readTextFile;
    return stub(
      Deno,
      "readTextFile",
      async (path) => {
        return fs.get(URI.from(path)) ??
          (options?.readThrough
            ? await original(path)
            : _throw(new Deno.errors.NotFound(`File not found: ${path}`)));
      },
    );
  },
};
export type ReadTextFileStub = ReturnType<typeof ReadTextFileStub.create>;

export const WriteTextFileStub = {
  create(
    fs: FileSystemFake,
  ) {
    return stub(
      Deno,
      "writeTextFile",
      (path, data) => {
        fs.set(URI.from(path), formatEOL(data.toString(), EOL.LF));
        return Promise.resolve();
      },
    );
  },
};
export type WriteTextFileStub = ReturnType<typeof WriteTextFileStub.create>;

export const FetchStub = {
  create(
    createResponse: (
      request: string | URL | Request,
      init: RequestInit & { original: typeof fetch },
    ) => Response | Promise<Response>,
  ) {
    const original = globalThis.fetch;
    return stub(
      globalThis,
      "fetch",
      (request, init) =>
        Promise.resolve(createResponse(request, { ...init, original })),
    );
  },
};
export type FetchStub = ReturnType<typeof FetchStub.create>;

export const LatestSemVerStub = {
  create(latest: string | SemVerString): FetchStub {
    return FetchStub.create(async (request, init) => {
      request = (request instanceof Request)
        ? request
        : new Request(request, init);
      const url = new URL(request.url);
      switch (url.hostname) {
        case "registry.npmjs.org":
          return new Response(
            JSON.stringify({ "dist-tags": { latest } }),
            { status: 200 },
          );
        case "deno.land": {
          if (request.method !== "HEAD") {
            return init.original(request);
          }
          const response = await init.original(request);
          await response.arrayBuffer();
          const semver = SemVerString.parse(response.url);
          if (!semver) {
            return response;
          }
          const url = new URL(response.url.replace(semver, latest));
          return {
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
            redirected: true,
            status: 302,
            url: url.href,
          } as Response;
        }
        default:
          return init.original(request, init);
      }
    });
  },
};
export type LatestSemVerStub = ReturnType<typeof LatestSemVerStub.create>;

/**
 * Enables all test stubs.
 */
export function enableTestMode() {
  const fs = new FileSystemFake();
  ReadTextFileStub.create(fs, { readThrough: true });
  WriteTextFileStub.create(fs);
  LatestSemVerStub.create("123.456.789");
  Deno.Command = createCommandStub();
}

/** Asserts that a spy is called as expected at any index. */
export function assertFindSpyCall<
  Self,
  Args extends unknown[],
  Return,
>(
  spy: Spy<Self, Args, Return>,
  expected: ExpectedSpyCall<Self, Args, Return>,
) {
  const call = spy.calls.find((_, index) => {
    try {
      assertSpyCall(spy, index, expected);
      return true;
    } catch {
      return false;
    }
  });
  if (!call) {
    throw new AssertionError(
      `Expected spy call does not exist: ${JSON.stringify(expected)}`,
    );
  }
  return call;
}

export function assertFindSpyCallArg<
  Self,
  Args extends unknown[],
  Return,
  ExpectedArg,
>(
  spy: Spy<Self, Args, Return>,
  argIndex: number,
  expected: ExpectedArg,
) {
  const call = spy.calls.find((_, index) => {
    try {
      assertSpyCallArg(spy, index, argIndex, expected);
      return true;
    } catch {
      return false;
    }
  });
  if (!call) {
    throw new AssertionError("Expected spy call does not exist");
  }
  return call;
}

/** Utility function to throw an error. */
function _throw(error: Error): never {
  throw error;
}

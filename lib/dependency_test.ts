import { afterAll, beforeAll, describe, it } from "./std/testing.ts";
import { assertEquals } from "./std/assert.ts";
import type { Path } from "./types.ts";
import type { SemVerString } from "./semver.ts";
import { Dependency } from "./dependency.ts";
import { LatestSemVerStub } from "./testing.ts";

describe("Dependency.parse()", () => {
  it("https://deno.land/std", () =>
    assertEquals(
      Dependency.parse(
        new URL("https://deno.land/std@0.1.0/version.ts"),
      ),
      {
        scheme: "https://",
        name: "deno.land/std",
        version: "0.1.0" as SemVerString,
        path: "/version.ts" as Path,
      },
    ));
  it("https://deno.land/std (no semver)", () =>
    assertEquals(
      Dependency.parse(
        new URL("https://deno.land/std/version.ts"),
      ),
      {
        scheme: "https://",
        name: "deno.land/std/version.ts",
      },
    ));
  it("https://deno.land/x/hono (with a leading 'v')", () =>
    assertEquals(
      Dependency.parse(
        new URL("https://deno.land/x/hono@v0.1.0"),
      ),
      {
        scheme: "https://",
        name: "deno.land/x/hono",
        version: "v0.1.0" as SemVerString,
        path: "" as Path,
      },
    ));
  it("npm:node-emoji", () =>
    assertEquals(
      Dependency.parse(
        new URL("npm:node-emoji@1.0.0"),
      ),
      {
        scheme: "npm:",
        name: "node-emoji",
        version: "1.0.0" as SemVerString,
        path: "" as Path,
      },
    ));
});

describe("Dependency.toURI()", () => {
  it("https://deno.land/std", () =>
    assertEquals(
      Dependency.toURI({
        scheme: "https://",
        name: "deno.land/std",
        version: "0.1.0" as SemVerString,
        path: "/version.ts" as Path,
      }),
      "https://deno.land/std@0.1.0/version.ts",
    ));
  it("https://deno.land/std (no semver)", () =>
    assertEquals(
      Dependency.toURI({
        scheme: "https://",
        name: "deno.land/std/version.ts",
      }),
      "https://deno.land/std/version.ts",
    ));
  it("npm:node-emoji", () =>
    assertEquals(
      Dependency.toURI({
        scheme: "npm:",
        name: "node-emoji",
        version: "1.0.0" as SemVerString,
        path: "" as Path,
      }),
      "npm:node-emoji@1.0.0",
    ));
});

describe("Dependency.resolveLatest()", () => {
  const LATEST = "123.456.789" as SemVerString;
  let stub: LatestSemVerStub;

  beforeAll(() => {
    stub = LatestSemVerStub.create(LATEST);
  });
  afterAll(() => {
    stub.restore();
  });

  it("https://deno.land/std/version.ts", async () =>
    assertEquals(
      await Dependency.resolveLatest(
        Dependency.parse(new URL("https://deno.land/std/version.ts")),
      ),
      {
        scheme: "https://",
        name: "deno.land/std",
        version: LATEST,
        path: "/version.ts" as Path,
      },
    ));
  it("https://deno.land/std@0.200.0/version.ts", async () =>
    assertEquals(
      await Dependency.resolveLatest(
        Dependency.parse(new URL("https://deno.land/std@0.200.0/version.ts")),
      ),
      {
        scheme: "https://",
        name: "deno.land/std",
        version: LATEST,
        path: "/version.ts" as Path,
      },
    ));
  it(
    "https://deno.land/std@0.200.0/assert/assert_equals.ts",
    async () =>
      assertEquals(
        await Dependency.resolveLatest(
          Dependency.parse(
            new URL(
              "https://deno.land/std@0.200.0/assert/assert_equals.ts",
            ),
          ),
        ),
        {
          scheme: "https://",
          name: "deno.land/std",
          version: LATEST,
          path: "/assert/assert_equals.ts" as Path,
        },
      ),
  );
});

describe("Dependency.resolveLatest() - pre-release", () => {
  let stub: LatestSemVerStub;

  beforeAll(() => {
    stub = LatestSemVerStub.create("123.456.789-alpha.1" as SemVerString);
  });
  afterAll(() => {
    stub.restore();
  });

  it("deno.land", async () =>
    assertEquals(
      await Dependency.resolveLatest(
        Dependency.parse(
          new URL("https://deno.land/x/deno_graph@0.50.0/mod.ts"),
        ),
      ),
      undefined,
    ));
  it("npm", async () =>
    assertEquals(
      await Dependency.resolveLatest(
        Dependency.parse(
          new URL("npm:node-emoji@1.0.0"),
        ),
      ),
      undefined,
    ));
});

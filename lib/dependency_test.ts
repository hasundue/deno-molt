import { afterAll, beforeAll, describe, it } from "./std/testing.ts";
import { assertEquals, assertExists, assertObjectMatch } from "./std/assert.ts";
import { isPreRelease, parse, resolveLatestVersion } from "./dependency.ts";
import { LatestSemVerStub } from "./testing.ts";

describe("parse", () => {
  it("https://deno.land/std", () =>
    assertObjectMatch(
      parse(
        new URL("https://deno.land/std@0.1.0/version.ts"),
      ),
      {
        name: "deno.land/std",
        version: "0.1.0",
        path: "/version.ts",
      },
    ));

  it("https://deno.land/std (no semver)", () =>
    assertObjectMatch(
      parse(
        new URL("https://deno.land/std/version.ts"),
      ),
      {
        name: "deno.land/std/version.ts",
      },
    ));

  it("https://deno.land/x/hono (with a leading 'v')", () =>
    assertObjectMatch(
      parse(
        new URL("https://deno.land/x/hono@v0.1.0"),
      ),
      {
        name: "deno.land/x/hono",
        version: "v0.1.0",
        path: "",
      },
    ));

  it("npm:node-emoji", () =>
    assertObjectMatch(
      parse(
        new URL("npm:node-emoji@1.0.0"),
      ),
      {
        name: "node-emoji",
        version: "1.0.0",
        path: "",
      },
    ));
});

Deno.test("isPreRelease", () => {
  assertEquals(
    isPreRelease("0.1.0"),
    false,
  );
  assertEquals(
    isPreRelease("0.1.0-alpha.1"),
    true,
  );
  assertEquals(
    isPreRelease("0.1.0-rc.1"),
    true,
  );
});

describe("resolveLatestVersion", () => {
  const LATEST = "123.456.789";
  let stub: LatestSemVerStub;

  beforeAll(() => {
    stub = LatestSemVerStub.create(LATEST);
  });

  afterAll(() => {
    stub.restore();
  });

  it("https://deno.land/std/version.ts", async () => {
    const updated = await resolveLatestVersion(
      parse(new URL("https://deno.land/std/version.ts")),
    );
    assertExists(updated);
    assertObjectMatch(updated, {
      name: "deno.land/std",
      version: LATEST,
      path: "/version.ts",
    });
  });

  it("https://deno.land/std@0.200.0/version.ts", async () => {
    const updated = await resolveLatestVersion(
      parse(new URL("https://deno.land/std@0.200.0/version.ts")),
    )!;
    assertExists(updated);
    assertObjectMatch(updated, {
      name: "deno.land/std",
      version: LATEST,
      path: "/version.ts",
    });
  });

  it("https://deno.land/std@0.200.0/assert/mod.ts", async () => {
    const updated = await resolveLatestVersion(
      parse(new URL("https://deno.land/std@0.200.0/assert/mod.ts")),
    );
    assertExists(updated);
    assertObjectMatch(updated, {
      name: "deno.land/std",
      version: LATEST,
      path: "/assert/mod.ts",
    });
  });
});

describe("resolveLatestVersion - pre-release", () => {
  let stub: LatestSemVerStub;

  beforeAll(() => {
    stub = LatestSemVerStub.create("123.456.789-alpha.1");
  });

  afterAll(() => {
    stub.restore();
  });

  it("deno.land", async () =>
    assertEquals(
      await resolveLatestVersion(
        parse(
          new URL("https://deno.land/x/deno_graph@0.50.0/mod.ts"),
        ),
      ),
      undefined,
    ));

  it("npm", async () =>
    assertEquals(
      await resolveLatestVersion(
        parse(
          new URL("npm:node-emoji@1.0.0"),
        ),
      ),
      undefined,
    ));
});

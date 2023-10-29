import {
  afterAll,
  assertSpyCalls,
  beforeAll,
  beforeEach,
  type ConstructorSpy,
  describe,
  it,
  type Stub,
} from "./std/testing.ts";
import {
  assertSomeSpyCall,
  createCommandStub,
  createReadTextFileStub,
  createWriteTextFileStub,
  FileSystemFake,
} from "./testing.ts";
import { URI } from "./uri.ts";
import { DependencyUpdate } from "./update.ts";
import { commitAll } from "./git.ts";

function normalizePath(path: string) {
  return Deno.build.os === "windows" ? path.replaceAll("/", "\\") : path;
}

describe("commitAll()", () => {
  let updates: DependencyUpdate[];
  let fileSystemFake: FileSystemFake;
  let writeTextFileStub: Stub;
  let readTextFileStub: Stub;
  let CommandStub: ConstructorSpy;

  beforeAll(async () => {
    updates = await DependencyUpdate.collect(
      "./test/fixtures/direct-import/mod.ts",
    );
    fileSystemFake = new FileSystemFake();
    readTextFileStub = createReadTextFileStub(fileSystemFake, {
      readThrough: true,
    });
    writeTextFileStub = createWriteTextFileStub(fileSystemFake);
  });

  afterAll(() => {
    writeTextFileStub.restore();
    readTextFileStub.restore();
    Deno.Command = CommandStub.original;
  });

  beforeEach(() => {
    fileSystemFake.clear();
    CommandStub = createCommandStub();
    Deno.Command = CommandStub;
  });

  // "git add src/fixtures/mod.ts src/fixtures/lib.ts",
  it("no grouping", async () => {
    await commitAll(updates);
    // TODO: Can't test this because of the order of targets is not guaranteed.
    // assertSomeSpyCall(CommandStub, {
    //   args: [
    //     "git",
    //     { args: ["add", "src/fixtures/mod.ts", "src/fixtures/lib.ts"] },
    //   ],
    // });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        { args: ["commit", "-m", "build(deps): update dependencies"] },
      ],
    });
    assertSpyCalls(CommandStub, 2);
  });

  it("group by dependency name", async () => {
    await commitAll(updates, {
      groupBy: (update) => update.name,
      composeCommitMessage: ({ group }) => `build(deps): update ${group}`,
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        { args: ["add", normalizePath("test/fixtures/direct-import/mod.ts")] },
      ],
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        { args: ["commit", "-m", "build(deps): update node-emoji"] },
      ],
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        { args: ["add", normalizePath("test/fixtures/direct-import/mod.ts")] },
      ],
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        {
          args: ["commit", "-m", "build(deps): update deno.land/x/deno_graph"],
        },
      ],
    });
    // TODO: Can't test this because of the order of targets is not guaranteed.
    // assertSomeSpyCall(CommandStub, {
    //   args: [
    //     "git",
    //     {
    //       args: [
    //         "add",
    //         normalizePath("test/fixtures/direct-import/mod.ts"),
    //         normalizePath("test/fixtures/direct-import/lib.ts"),
    //       ],
    //     },
    //   ],
    // });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        { args: ["commit", "-m", "build(deps): update deno.land/std"] },
      ],
    });
    assertSpyCalls(CommandStub, 6);
  });

  it("group by module (file) name", async () => {
    await commitAll(updates, {
      groupBy: (update) => URI.relative(update.referrer),
      composeCommitMessage: ({ group }) => `build(deps): update ${group}`,
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        { args: ["add", normalizePath("test/fixtures/direct-import/mod.ts")] },
      ],
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        {
          args: [
            "commit",
            "-m",
            normalizePath(
              "build(deps): update test/fixtures/direct-import/mod.ts",
            ),
          ],
        },
      ],
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        { args: ["add", normalizePath("test/fixtures/direct-import/lib.ts")] },
      ],
    });
    assertSomeSpyCall(CommandStub, {
      args: [
        "git",
        {
          args: [
            "commit",
            "-m",
            normalizePath(
              "build(deps): update test/fixtures/direct-import/lib.ts",
            ),
          ],
        },
      ],
    });
    assertSpyCalls(CommandStub, 4);
  });
});

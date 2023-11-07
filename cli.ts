import { distinct, filterKeys, mapEntries } from "./lib/std/collections.ts";
import { parse as parseJsonc } from "./lib/std/jsonc.ts";
import { dirname, extname, join } from "./lib/std/path.ts";
import { colors, Command, Input, List, Select } from "./lib/x/cliffy.ts";
import { $ } from "./lib/x/dax.ts";
import { ensure, is } from "./lib/x/unknownutil.ts";
import { URI } from "./lib/uri.ts";
import { DependencyUpdate } from "./lib/update.ts";
import { FileUpdate } from "./lib/file.ts";
import { GitCommitSequence } from "./lib/git.ts";
import { Dependency, parseSemVer } from "./lib/dependency.ts";
import {
  createCommandStub,
  FileSystemFake,
  LatestSemVerStub,
  ReadTextFileStub,
  WriteTextFileStub,
} from "./lib/testing.ts";

const { gray, yellow, bold, cyan } = colors;
const checkCommand = new Command()
  .description("Check for the latest version of dependencies")
  .option("--import-map <file:string>", "Specify import map file")
  .arguments("<entrypoints...:string>")
  .action(checkAction);

async function checkAction(
  options: { importMap?: string },
  ...entrypoints: string[]
) {
  _ensureJsFiles(entrypoints);
  const updates = await _collect(entrypoints, options);
  _list(updates);
  const action = await Select.prompt({
    message: "Choose an action",
    options: [
      { name: "Abort", value: "abort" },
      { name: "Write changes to local files", value: "write" },
      { name: "Commit changes to git", value: "commit" },
    ],
  });
  switch (action) {
    case "abort":
      return;
    case "write":
      return _write(updates);
    case "commit": {
      const prefix = await Input.prompt({
        message: "Prefix for commit messages",
        default: "build(deps):",
      });
      const tasks = await _getTasks();
      const suggestions = Object.keys(tasks);
      const preCommit = await List.prompt(
        {
          message: "Tasks to run before each commit (comma separated)",
          suggestions,
        },
      );
      const postCommit = await List.prompt(
        {
          message: "Tasks to run after each commit (comma separated)",
          suggestions,
        },
      );
      console.log();
      return _commit(updates, {
        preCommit: filterKeys(tasks, (key) => preCommit.includes(key)),
        postCommit: filterKeys(tasks, (key) => postCommit.includes(key)),
        prefix,
      });
    }
  }
}

const updateCommand = new Command()
  .description("Update dependencies to the latest version")
  .option("--import-map <file:string>", "Specify import map file")
  .option("--commit", "Commit changes to git")
  .option("--pre-commit=<tasks:string[]>", "Run tasks before each commit", {
    depends: ["commit"],
  })
  .option("--post-commit=<tasks:string[]>", "Run tasks after each commit", {
    depends: ["commit"],
  })
  .option("--prefix <prefix:string>", "Prefix for commit messages", {
    depends: ["commit"],
  })
  .option("--summary <file:string>", "Write a summary of changes to file")
  .option("--report <file:string>", "Write a report of changes to file")
  .arguments("<entrypoints...:string>")
  .action(updateAction);

async function updateAction(
  options: {
    commit?: boolean;
    importMap?: string;
    preCommit?: string[];
    postCommit?: string[];
    prefix?: string;
    summary?: string;
    report?: string;
  },
  ...entrypoints: string[]
) {
  _ensureJsFiles(entrypoints);
  const updates = await _collect(entrypoints, options);
  _list(updates);
  if (options.commit) {
    return _commit(updates, {
      ...options,
      preCommit: filterKeys(
        await _getTasks(),
        (key) => options.preCommit?.includes(key) ?? false,
      ),
      postCommit: filterKeys(
        await _getTasks(),
        (key) => options.postCommit?.includes(key) ?? false,
      ),
    });
  }
  return _write(updates, options);
}

async function _collect(
  entrypoints: string[],
  options: { importMap?: string },
): Promise<DependencyUpdate[]> {
  return await $.progress("Checking for updates").with(async () => {
    const updates = await Promise.all(
      entrypoints.map(async (entrypoint) =>
        await DependencyUpdate.collect(entrypoint, {
          importMap: options.importMap ?? await _findDenoJson(entrypoint),
        })
      ),
    ).then((results) => results.flat());
    if (!updates.length) {
      console.log("🍵 No updates found");
      Deno.exit(0);
    }
    return updates;
  });
}

function _findDenoJson(entrypoint: string) {
  return _findFileUp(entrypoint, "deno.json", "deno.jsonc");
}

type TaskRecord = Record<string, string[]>;

async function _getTasks() {
  const tasks: TaskRecord = {
    fmt: ["fmt"],
    lint: ["lint"],
    test: ["test"],
  };
  const config = await _findDenoJson(Deno.cwd());
  if (!config) {
    return tasks;
  }
  try {
    const json = ensure(
      parseJsonc(await Deno.readTextFile(config)),
      is.ObjectOf({ tasks: is.Record }),
    );
    return {
      ...tasks,
      ...mapEntries(json.tasks, ([name]) => [name, ["task", "-q", name]]),
    };
  } catch {
    return tasks;
  }
}

function _list(updates: DependencyUpdate[]) {
  console.log(`💡 Found ${updates.length > 1 ? "updates" : "an update"}:`);
  const dependencies = new Map<string, DependencyUpdate[]>();
  for (const u of updates) {
    const list = dependencies.get(u.to.name) ?? [];
    list.push(u);
    dependencies.set(u.to.name, list);
  }
  for (const [name, list] of dependencies.entries()) {
    console.log();
    const froms = distinct(list.map((u) => u.from.version)).join(", ");
    console.log(
      `📦 ${bold(name)} ${yellow(froms)} => ${yellow(list[0].to.version)}`,
    );
    distinct(
      list.map((u) => {
        const source = URI.relative(u.map?.source ?? u.referrer);
        return `  ${source} ` + gray(u.from.version ?? "");
      }),
    ).forEach((line) => console.log(line));
  }
}

async function _write(
  updates: DependencyUpdate[],
  options?: {
    summary?: string;
    report?: string;
  },
) {
  const results = FileUpdate.collect(updates);
  console.log();
  await FileUpdate.writeAll(results, {
    onWrite: (module) => console.log(`💾 ${URI.relative(module.specifier)}`),
  });
  if (options?.summary || options?.report) {
    console.log();
  }
  if (options?.summary) {
    await Deno.writeTextFile(options.summary, "Update dependencies");
    console.log(`📄 ${options.summary}`);
  }
  if (options?.report) {
    const content = distinct(
      updates.map((u) => `- ${u.to.name} ${u.from.version} => ${u.to.version}`),
    ).join("\n");
    await Deno.writeTextFile(options.report, content);
    console.log(`📄 ${options.report}`);
  }
}

async function _commit(
  updates: DependencyUpdate[],
  options: {
    preCommit?: TaskRecord;
    postCommit?: TaskRecord;
    prefix?: string;
    summary?: string;
    report?: string;
  },
) {
  const preCommitTasks = Object.entries(options?.preCommit ?? {});
  const commits = GitCommitSequence.from(updates, {
    groupBy: (dependency) => dependency.to.name,
    composeCommitMessage: ({ group, version }) =>
      _formatPrefix(options.prefix) + `bump ${group}` +
      (version?.from ? ` from ${version?.from}` : "") +
      (version?.to ? ` to ${version?.to}` : ""),
    preCommit: preCommitTasks.length > 0
      ? async (commit) => {
        const tasks = Object.entries(options?.preCommit ?? {});
        console.log(`\n💾 ${commit.message}`);
        for (const t of tasks) {
          await _task(t);
        }
      }
      : undefined,
    postCommit: async (commit) => {
      console.log(`📝 ${commit.message}`);
      for (const task of Object.entries(options?.postCommit ?? {})) {
        await _task(task);
      }
    },
  });
  if (!commits.options.preCommit) {
    console.log();
  }
  await GitCommitSequence.exec(commits);
  if (options?.summary || options?.report) {
    console.log();
  }
  if (options?.summary) {
    await Deno.writeTextFile(options.summary, _summary(commits, options));
    console.log(`📄 ${options.summary}`);
  }
  if (options?.report) {
    await Deno.writeTextFile(options.report, _report(commits));
    console.log(`📄 ${options.report}`);
  }
}

async function _task([name, args]: [string, string[]]) {
  console.log(`🔨 Running task ${cyan(name)}...`);
  const { code } = await new Deno.Command("deno", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code != 0) {
    Deno.exit(code);
  }
}

function _ensureJsFiles(paths: string[]) {
  let errors = 0;
  for (const path of paths) {
    const ext = extname(path);
    if (
      !(ext === "" || ext === ".js" || ext === ".ts" || ext === ".jsx" ||
        ext === ".tsx")
    ) {
      console.error(`❌ file must be javascript or typescript: "${path}"`);
      errors += 1;
      continue;
    }
    try {
      if (!Deno.statSync(path).isFile) {
        console.error(`❌ not a file: "${path}"`);
        errors += 1;
      }
    } catch {
      console.error(`❌ path does not exist: "${path}"`);
      errors += 1;
    }
  }
  if (errors != 0) Deno.exit(1);
}

/**
 * Recursively searches for a file with the specified name in parent directories
 * starting from the given entrypoint directory.
 *
 * @param entrypoint - The file to start the search from its parent dir.
 * @param files - The name of the files to search for.
 * @returns The first file path found or undefined if no file was found.
 */
async function _findFileUp(entrypoint: string, ...files: string[]) {
  let path = dirname(entrypoint);
  for (;;) {
    for await (const dirEntry of Deno.readDir(path)) {
      if (files.includes(dirEntry.name)) {
        return join(path, dirEntry.name);
      }
    }
    const newPath = dirname(path);
    if (newPath === path) {
      // reached the system root
      return undefined;
    }
    path = newPath;
  }
}

function _summary(
  sequence: GitCommitSequence,
  options: { prefix?: string },
): string {
  if (sequence.commits.length === 0) {
    return "No updates";
  }
  if (sequence.commits.length === 1) {
    return sequence.commits[0].message;
  }
  const groups = sequence.commits.map((commit) => commit.group).join(", ");
  const full = _formatPrefix(options.prefix) + `update ${groups}`;
  return (full.length <= 50)
    ? full
    : _formatPrefix(options.prefix) + "update dependencies";
}

function _report(sequence: GitCommitSequence): string {
  return sequence.commits.map((commit) => `- ${commit.message}`).join("\n");
}

function _formatPrefix(prefix: string | undefined) {
  return prefix ? prefix.trimEnd() + " " : "";
}

async function versionCommand() {
  const version = parseSemVer(import.meta.url) ??
    await $.progress("Fetching version info").with(async () => {
      const latest = await Dependency.resolveLatest(
        Dependency.parse(new URL("https://deno.land/x/molt/cli.ts")),
      );
      return latest ? latest.version : undefined;
    }) ?? "unknown";
  console.log(version);
}

function _enableTestMode() {
  if (Deno.env.get("MOLT_TEST")) {
    const fs = new FileSystemFake();
    ReadTextFileStub.create(fs, { readThrough: true });
    WriteTextFileStub.create(fs);
    LatestSemVerStub.create("123.456.789");
    Deno.Command = createCommandStub();
  }
}

const main = new Command()
  .name("molt")
  .description("A tool for updating dependencies in Deno projects")
  .action(function () {
    this.showHelp();
  })
  .versionOption(
    "-v, --version",
    "Print version info.",
    versionCommand,
  )
  .command("check", checkCommand)
  .command("update", updateCommand);

try {
  if (Deno.env.get("MOLT_TEST")) {
    _enableTestMode();
  }
  await main.parse(Deno.args);
} catch (error) {
  console.error(error);
  Deno.exit(1);
}

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyReleaseArtifact } from "./lib/release-artifact.mjs";

const inputPath = path.resolve(process.argv[2] ?? "package-artifacts");
const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor !== 22 && nodeMajor !== 24) {
  console.error(
    `Packed runtime smoke requires Node 22 or 24; received Node ${process.versions.node}.`,
  );
  process.exit(1);
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_cache: path.join(cwd, ".npm-cache"),
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }

  return result.stdout;
}

const artifact = await verifyReleaseArtifact(inputPath);
const tarball = artifact.tarballPath;
const workdir = await mkdtemp(path.join(tmpdir(), "opencode-quota-package-smoke-"));

try {
  run("npm", ["init", "-y"], workdir);
  run("npm", ["install", "--omit=dev", tarball], workdir);
  run("npm", ["install", "--omit=dev", "@opentelemetry/api@1.9.0"], workdir);

  const moduleSmoke = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import path from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";

    const rootExportUrl = import.meta.resolve("@slkiser/opencode-quota");
    await import("@slkiser/opencode-quota");
    await import("@slkiser/opencode-quota/server");

    const tuiExportUrl = import.meta.resolve("@slkiser/opencode-quota/tui");
    const tuiExportPath = fileURLToPath(tuiExportUrl);
    assert.match(tuiExportPath, /node_modules\\/\\@slkiser\\/opencode-quota\\/dist\\/tui\\.js$/);
    const tuiSource = await readFile(tuiExportPath, "utf8");
    assert.ok(tuiSource.includes("@slkiser/opencode-quota"));
    assert.ok(tuiSource.includes("const pluginModule"));
    assert.ok(tuiSource.includes("tui"));
    assert.ok(!tuiSource.includes("jsx-dev-runtime"));

    const pkg = JSON.parse(
      await readFile("node_modules/@slkiser/opencode-quota/package.json", "utf8"),
    );
    assert.equal(pkg.engines?.node, ">=22.0.0");
    assert.equal(pkg.peerDependencies?.["@opentelemetry/api"], "^1.9.0");
    assert.equal(pkg.peerDependenciesMeta?.["@opentelemetry/api"]?.optional, true);

    const packageRoot = path.resolve(path.dirname(fileURLToPath(rootExportUrl)), "..");
    const telemetry = await import(
      pathToFileURL(path.join(packageRoot, "dist", "lib", "quota-telemetry.js"))
    );
    assert.ok(
      telemetry.configureQuotaTelemetry({
        owner: {},
        enabled: true,
        identity: "packed-present",
      }),
    );
    await telemetry.__flushQuotaTelemetryInitializationForTests();
  `;

  run(process.execPath, ["--input-type=module", "--eval", moduleSmoke], workdir);

  await rm(path.join(workdir, "node_modules", "@opentelemetry", "api"), {
    recursive: true,
    force: true,
  });
  const absentOptionalDependencySmoke = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import path from "node:path";
    import { fileURLToPath, pathToFileURL } from "node:url";

    await assert.rejects(import("@opentelemetry/api"));
    const rootExportUrl = import.meta.resolve("@slkiser/opencode-quota");
    await import("@slkiser/opencode-quota");
    await import("@slkiser/opencode-quota/server");
    const tuiExportPath = fileURLToPath(import.meta.resolve("@slkiser/opencode-quota/tui"));
    assert.ok((await readFile(tuiExportPath, "utf8")).includes("@slkiser/opencode-quota"));

    const packageRoot = path.resolve(path.dirname(fileURLToPath(rootExportUrl)), "..");
    const telemetry = await import(
      pathToFileURL(path.join(packageRoot, "dist", "lib", "quota-telemetry.js"))
    );
    assert.ok(
      telemetry.configureQuotaTelemetry({
        owner: {},
        enabled: true,
        identity: "packed-absent",
      }),
    );
    await telemetry.__flushQuotaTelemetryInitializationForTests();
  `;
  run(process.execPath, ["--input-type=module", "--eval", absentOptionalDependencySmoke], workdir);

  const cliPath = path.join(
    workdir,
    "node_modules",
    "@slkiser",
    "opencode-quota",
    "dist",
    "bin",
    "opencode-quota.js",
  );
  const cliOutput = run(process.execPath, [cliPath, "--help"], workdir);
  for (const expected of [
    "Usage:",
    "opencode-quota init",
    "opencode-quota show",
    "opencode-quota update",
  ]) {
    if (!cliOutput.includes(expected)) {
      throw new Error(`Packed CLI help is missing: ${expected}`);
    }
  }

  console.log(
    `Packed package smoke passed for ${artifact.filename} on Node ${process.versions.node} (sha256 ${artifact.sha256}).`,
  );
} finally {
  await rm(workdir, { recursive: true, force: true });
}

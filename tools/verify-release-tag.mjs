#!/usr/bin/env node

/**
 * Release-tag gate for a Chatto `v*` release.
 *
 * A push of a `v*` tag starts the full release job. That job publishes
 * container image tags and a Homebrew formula, and none of those can be
 * withdrawn. This module holds the one answer to "may this tag release?" and
 * it gives the two values that the rest of the release job needs.
 *
 * ## The four rules
 *
 * The gate refuses the tag unless every rule holds. It applies them in this
 * order, and it stops at the first rule that refuses.
 *
 * 1. **The tagged commit is reachable from a release branch.** It must be an
 *    ancestor of `origin/main` or of an `origin/release-*` branch. A tag on a
 *    commit that no release branch holds cannot release.
 * 2. **The tagged commit has a parent.** The next rule compares the commit
 *    with its first parent, so a root commit cannot release.
 * 3. **The tagged commit changes release-please files only.** See
 *    {@link releasePleaseAllowlist}. A release commit is the commit that a
 *    release-please pull request merges, so it holds the version bump and the
 *    changelog and nothing else. Product code in a release commit means that
 *    somebody hand-made the tag, and the gate refuses it.
 * 4. **`latest` moves for the highest stable version only.** This rule sets
 *    the `push_latest` output rather than refusing the tag.
 *
 * ## Why this is a module and not workflow script
 *
 * The gate is the one thing between a hand-pushed `v*` tag and a published
 * release, and a real release was the only thing that ever ran it. A gate that
 * fails closed gives no signal when it rots: an allowlist entry that names a
 * file which no longer exists simply never matches, and nothing notices. The
 * test beside this module runs on every pull request, against Git fixture
 * repositories, so the gate is proven to refuse what it must refuse before it
 * matters. Issue #42 holds the reasoning.
 *
 * ## Lifecycle
 *
 * The release workflow runs this module one time for each `v*` tag, before it
 * builds anything. The module reads the Git repository and the release-please
 * configuration in the working tree, and it writes no files. It needs no
 * network, no credentials and no release in flight, so a contributor can run
 * the same command against a local clone at any time.
 *
 * ## Command line
 *
 *     node tools/verify-release-tag.mjs --tag v0.5.0
 *
 * The module writes GitHub Actions output lines to stdout, and the release
 * workflow appends them to `$GITHUB_OUTPUT`. When the gate refuses, the module
 * writes the reason to stderr with an `::error::` annotation and exits with a
 * non-zero status.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Key of the release-please package that a `v*` tag releases.
 *
 * `.release-please-config.json` holds one package for each independently
 * versioned component. A `v*` tag releases the root package only. The other
 * packages carry their own tag prefix, such as `chatto-desktop/v*`, and this
 * gate does not run for them.
 */
export const ROOT_PACKAGE = ".";

/**
 * Path that release-please uses when a package declares no `changelog-path`.
 */
export const DEFAULT_CHANGELOG_PATH = "CHANGELOG.md";

/**
 * Release-please configuration path that the release workflow declares.
 *
 * The workflow passes its own value on the command line, so the two cannot
 * drift. This default is here for a contributor who runs the command against a
 * local clone. A test asserts that it equals the value in the workflow.
 */
export const DEFAULT_CONFIG_PATH = ".release-please-config.json";

/**
 * Release-please manifest path that the release workflow declares. See
 * {@link DEFAULT_CONFIG_PATH}.
 */
export const DEFAULT_MANIFEST_PATH = ".release-please-manifest.json";

/**
 * Allowlist entries that name files which do not exist.
 *
 * The workflow script that this module replaces listed seven paths, and two of
 * them name files that this repository does not hold. Commits `0ef6278c` and
 * `a630f3a0` added them, and the configuration shape that needed them went
 * away afterwards.
 *
 * **They stay, and this is deliberate.** The gate fails closed, so an entry
 * that matches no file makes the gate stricter and never looser. To drop them
 * changes what the gate accepts, and this module is a structural move that
 * must accept and refuse exactly what the workflow script accepted and refused.
 * Issue #42 keeps the removal for its own change, where the diff shows it.
 *
 * Note that these two are literals rather than a rule applied to
 * {@link DEFAULT_CONFIG_PATH}. A rule would make a new dead entry whenever the
 * configuration path changes, and that is a behaviour that nobody asked for.
 */
export const DEAD_ALLOWLIST_PATHS = Object.freeze([
  ".release-please-config-main.json",
  ".release-please-manifest-main.json",
]);

/** Error that says the gate refuses to release the tag. */
export class ReleaseTagRefusal extends Error {
  /**
   * @param {string} message One line that says why the gate refuses.
   * @param {string[]} [details] More lines, such as the disallowed paths.
   */
  constructor(message, details = []) {
    super(message);
    this.name = "ReleaseTagRefusal";
    /** @type {string[]} */
    this.details = details;
  }
}

/**
 * Read a release-please configuration file.
 *
 * @param {string} configPath Path to `.release-please-config.json`, relative
 *   to `cwd` or absolute.
 * @param {object} [options]
 * @param {string} [options.cwd] Directory that holds the repository.
 * @returns {object} The parsed configuration.
 * @throws {SyntaxError} If the file is not valid JSON.
 */
export function readReleasePleaseConfig(configPath, { cwd } = {}) {
  const resolved = cwd ? resolvePath(cwd, configPath) : configPath;
  return JSON.parse(readFileSync(resolved, "utf8"));
}

/**
 * Give the paths that a release commit may change.
 *
 * Five of the paths come from the release-please configuration itself, so the
 * gate cannot disagree with the tool whose commits it inspects:
 *
 * - the configuration path and the manifest path, which the caller supplies,
 *   because a JSON file cannot name itself;
 * - the root package's `changelog-path`;
 * - the root package's `extra-files[].path`, which are the files that hold the
 *   version.
 *
 * The two entries in {@link DEAD_ALLOWLIST_PATHS} follow them. Read that
 * constant before you remove one.
 *
 * The `extra-files` paths of a package are relative to the package directory.
 * This function reads the root package only, where the package directory is
 * the repository root, so the paths need no prefix.
 *
 * @param {object} input
 * @param {object} input.config A parsed release-please configuration.
 * @param {string} input.configPath Path of the configuration file itself.
 * @param {string} input.manifestPath Path of the manifest file.
 * @returns {string[]} Repository-relative paths, without duplicates.
 * @throws {TypeError} If the configuration holds no root package.
 */
export function releasePleaseAllowlist({ config, configPath, manifestPath }) {
  const root = config?.packages?.[ROOT_PACKAGE];
  if (!root || typeof root !== "object") {
    throw new TypeError(
      `The release-please configuration holds no "${ROOT_PACKAGE}" package.`,
    );
  }

  const extraFiles = Array.isArray(root["extra-files"]) ? root["extra-files"] : [];
  const paths = [
    configPath,
    manifestPath,
    root["changelog-path"] ?? DEFAULT_CHANGELOG_PATH,
    // An `extra-files` entry is a path on its own, or an object that holds the
    // path with the rule that release-please applies to it.
    ...extraFiles.map((entry) => (typeof entry === "string" ? entry : entry?.path)),
    ...DEAD_ALLOWLIST_PATHS,
  ];

  for (const value of paths) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(
        `The release-please configuration holds an entry with no path.`,
      );
    }
  }

  return [...new Set(paths)];
}

/**
 * @typedef {object} ReleaseTagVerdict
 * @property {string} tag The tag that the gate examined.
 * @property {string} commit Full object name of the tagged commit.
 * @property {string} sourceBranch Branch that holds the tagged commit, such as
 *   `main` or `release-0.5`. The release workflow consumes no output for this
 *   value; it is here because it is the answer to rule 1.
 * @property {string} version The tag without its `v` prefix.
 * @property {boolean} isStable False for a prerelease.
 * @property {boolean} pushLatest True when this release is the highest stable
 *   version, so `latest` may move to it.
 */

/**
 * Apply the gate to one release tag.
 *
 * @param {object} input
 * @param {string} input.tag The release tag, such as `v0.5.0`.
 * @param {string[]} input.allowlist Paths that the commit may change. See
 *   {@link releasePleaseAllowlist}.
 * @param {string} [input.cwd] Directory that holds the repository. Defaults to
 *   the working directory of the process.
 * @returns {ReleaseTagVerdict}
 * @throws {ReleaseTagRefusal} If any rule refuses the tag.
 */
export function verifyReleaseTag({ tag, allowlist, cwd = process.cwd() }) {
  const commit = git(cwd, ["rev-parse", `${tag}^{commit}`]);

  const sourceBranch = findSourceBranch(cwd, commit);
  if (sourceBranch === "") {
    throw new ReleaseTagRefusal(
      `Refusing to release ${tag}: tagged commit is not reachable from origin/main or an origin/release-* branch.`,
    );
  }

  if (parentCount(cwd, commit) < 1) {
    throw new ReleaseTagRefusal(
      `Refusing to release ${tag}: tagged commit has no parent to compare against.`,
    );
  }

  const disallowed = changedPaths(cwd, commit).filter(
    (path) => !allowlist.includes(path),
  );
  if (disallowed.length > 0) {
    throw new ReleaseTagRefusal(
      `Refusing to release ${tag}: tagged commit contains non-release-please files.`,
      disallowed.map((path) => `Disallowed file: ${path}`),
    );
  }

  const version = tag.replace(/^v/, "");
  // A version that holds a `-` is a prerelease. This is the test that the
  // workflow script used, and this module keeps it. SemVer build metadata
  // after `+` may also hold a `-`, so this test differs from the SemVer
  // parser in `tools/release-image-tags.mjs`. No Chatto release has used
  // build metadata. Issue #41 owns making one parser answer this question in
  // every place that asks it.
  const isStable = !version.includes("-");

  return {
    tag,
    commit,
    sourceBranch,
    version,
    isStable,
    pushLatest: isStable && version === highestStableVersion(cwd, tag),
  };
}

/**
 * Give the GitHub Actions output lines for a verdict.
 *
 * The release job reads `push_latest` for the Docker tag policy and exposes
 * `is_stable` as a job output, which the documentation release job needs.
 *
 * @param {ReleaseTagVerdict} verdict
 * @returns {string} Text that ends with a newline.
 */
export function formatGithubOutput(verdict) {
  return [
    `push_latest=${verdict.pushLatest}`,
    `is_stable=${verdict.isStable}`,
    "",
  ].join("\n");
}

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{tag: string, configPath: string, manifestPath: string}}
 * @throws {TypeError} If an option is unknown, or if `--tag` is absent.
 */
export function parseArgs(argv) {
  let tag;
  let configPath = DEFAULT_CONFIG_PATH;
  let manifestPath = DEFAULT_MANIFEST_PATH;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--tag" || option === "--config" || option === "--manifest") {
      if (value === undefined) throw new TypeError(`${option} needs a value`);
      if (option === "--tag") tag = value;
      else if (option === "--config") configPath = value;
      else manifestPath = value;
      index += 1;
    } else {
      throw new TypeError(`Unknown option: ${option}`);
    }
  }
  if (tag === undefined) throw new TypeError("--tag is required");
  return { tag, configPath, manifestPath };
}

/**
 * Highest stable version that the repository holds a tag for.
 *
 * A prerelease tag never counts, and neither does a tag that carries build
 * metadata, because the pattern accepts three numbers and nothing else. The
 * released tag is itself in the repository, so a stable release always finds
 * at least its own version.
 *
 * @param {string} cwd
 * @param {string} tag The tag under examination, for the refusal message.
 * @returns {string}
 * @throws {ReleaseTagRefusal} If the repository holds no stable release tag.
 */
function highestStableVersion(cwd, tag) {
  const versions = git(cwd, ["tag", "--list", "v[0-9]*.[0-9]*.[0-9]*"])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^v/, ""))
    .filter((version) => /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
    .sort(compareStableVersions);

  if (versions.length === 0) {
    throw new ReleaseTagRefusal(
      `Refusing to release ${tag}: the repository holds no stable release tag, so the highest stable version cannot be found.`,
    );
  }
  return versions[versions.length - 1];
}

/**
 * Order two `major.minor.patch` versions by number, and not by text.
 *
 * `0.4.10` follows `0.4.9`. Text order gives the opposite answer.
 */
function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

/**
 * Name of the release branch that holds the commit, or an empty string.
 *
 * `main` comes first, because almost every release comes from it.
 */
function findSourceBranch(cwd, commit) {
  if (isAncestor(cwd, commit, "origin/main")) return "main";
  const refs = git(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/remotes/origin/release-*",
  ])
    .split("\n")
    .filter((line) => line !== "");
  for (const ref of refs) {
    if (isAncestor(cwd, commit, ref)) {
      return ref.replace(/^refs\/remotes\/origin\//, "");
    }
  }
  return "";
}

function isAncestor(cwd, commit, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function parentCount(cwd, commit) {
  const fields = git(cwd, ["rev-list", "--parents", "-n", "1", commit]).split(/\s+/);
  return fields.length - 1;
}

/**
 * Paths that the commit changes against its first parent.
 *
 * `<commit>^` is the first parent, so a merge commit is compared with the
 * branch that it merges into.
 */
function changedPaths(cwd, commit) {
  return git(cwd, ["diff", "--name-only", `${commit}^`, commit])
    .split("\n")
    .filter((line) => line !== "");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function main(argv) {
  try {
    const { tag, configPath, manifestPath } = parseArgs(argv);
    const allowlist = releasePleaseAllowlist({
      config: readReleasePleaseConfig(configPath),
      configPath,
      manifestPath,
    });
    process.stdout.write(
      formatGithubOutput(verifyReleaseTag({ tag, allowlist })),
    );
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    for (const line of error.details ?? []) process.stderr.write(`${line}\n`);
    if (!(error instanceof ReleaseTagRefusal)) {
      process.stderr.write(
        "usage: node tools/verify-release-tag.mjs --tag <tag> [--config <path>] [--manifest <path>]\n",
      );
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

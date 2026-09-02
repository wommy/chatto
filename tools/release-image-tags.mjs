#!/usr/bin/env node

/**
 * Docker tag policy for a Chatto release.
 *
 * A release publishes two images: `ghcr.io/chattocorp/chatto` (the server)
 * and `ghcr.io/chattocorp/chatto-client` (the frontend). This module gives
 * the one answer to "which tags does this release publish?" for both images.
 *
 * ## Why the policy is not in `.goreleaser.yml`
 *
 * GoReleaser pushes the server tags, but it must not decide which tags to
 * push. Nothing evaluates a GoReleaser template before the push that acts on
 * it: `docker.ManifestPipe` has a `Publish` method and no `Run` method, and
 * `goreleaser check` evaluates no templates. Thus a condition in a `skip_push`
 * template is a decision that no test can reach. `.goreleaser.yml` reads the
 * three `CHATTO_SKIP_PUSH_*` values that this module supplies, and it makes no
 * decision of its own.
 *
 * ## The policy
 *
 * | Tag                 | `chatto`                        | `chatto-client` |
 * | ------------------- | ------------------------------- | --------------- |
 * | `{version}`         | always                          | always          |
 * | `{major}.{minor}`   | stable release                  | never           |
 * | `latest`            | stable release, and only the highest stable version | the same |
 * | `next`              | prerelease                      | prerelease      |
 *
 * The client image gets no `{major}.{minor}` tag. This table is the tag set
 * that a release publishes today, and this module keeps it unchanged. To give
 * the client image a `{major}.{minor}` tag is a change of behaviour, and it
 * must come as its own change. Issue #43 holds that decision.
 *
 * ## Lifecycle
 *
 * The release workflow runs this module one time for each release tag. It runs
 * the module before GoReleaser and before the client image build. The module
 * reads no repository state and writes no files. All input comes from the
 * command line.
 *
 * ## Command line
 *
 *     node tools/release-image-tags.mjs --tag v0.5.0 --push-latest true
 *
 * The module writes GitHub Actions output lines to stdout. The release
 * workflow appends them to `$GITHUB_OUTPUT`. A contributor can run the same
 * command at any time, because the module needs no release in flight.
 */

import { pathToFileURL } from "node:url";

/** Image repository that holds the Chatto server image. */
export const SERVER_IMAGE = "ghcr.io/chattocorp/chatto";

/** Image repository that holds the Chatto frontend image. */
export const CLIENT_IMAGE = "ghcr.io/chattocorp/chatto-client";

/**
 * Environment variable that `.goreleaser.yml` reads for each floating server
 * manifest. The key is the property name in {@link ReleaseImageTags.skipPush}.
 *
 * Each variable holds the string `"true"` or `"false"`. GoReleaser skips the
 * manifest only for the exact string `"true"`
 * (`internal/pipe/docker/manifest.go:99-105`). GoReleaser templates use the
 * `missingkey=error` option (`internal/tmpl/tmpl.go:275`), so the release
 * workflow must set every one of these variables. If one is absent, the
 * manifest push fails.
 */
export const SKIP_PUSH_ENV = Object.freeze({
  majorMinor: "CHATTO_SKIP_PUSH_MAJOR_MINOR",
  latest: "CHATTO_SKIP_PUSH_LATEST",
  next: "CHATTO_SKIP_PUSH_NEXT",
});

/** Delimiter for the multi-line GitHub Actions outputs. */
const OUTPUT_DELIMITER = "CHATTO_IMAGE_TAGS";

/**
 * Anchored SemVer 2.0.0 pattern. It keeps the prerelease and the build
 * metadata in separate groups.
 *
 * `apps/desktop/scripts/version.mjs` holds an equivalent pattern, but that
 * pattern is inside `macOSVersions()` and it computes macOS bundle versions.
 * There is no exported parser to reuse. Issue #41 owns the four other places
 * that classify a version, and it can make this the one parser for all of
 * them.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * @typedef {object} ReleaseVersion
 * @property {string} version The tag without its `v` prefix.
 * @property {string} major
 * @property {string} minor
 * @property {string} patch
 * @property {string} prerelease Empty for a stable version.
 * @property {string} build Build metadata. Empty when the tag has none.
 */

/**
 * Parse a release tag.
 *
 * The version is the tag without one leading `v`, because GoReleaser removes
 * the prefix without a condition (`internal/pipe/git/git.go:58`). Build
 * metadata after `+` is not a prerelease, which agrees with the SemVer
 * specification and with the parse that GoReleaser uses. Note that Docker
 * refuses a `+` character in a tag, so a release tag with build metadata
 * cannot publish an image. No Chatto release has used build metadata.
 *
 * @param {string} tag A release tag, such as `v0.5.0` or `0.5.0-alpha.1`.
 * @returns {ReleaseVersion}
 * @throws {TypeError} If the tag is not a valid SemVer version.
 */
export function parseReleaseTag(tag) {
  const version = String(tag).replace(/^v/, "");
  const match = SEMVER.exec(version);
  if (!match) throw new TypeError(`Invalid release tag: ${tag}`);
  return {
    version,
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ?? "",
    build: match[5] ?? "",
  };
}

/**
 * @typedef {object} ReleaseImageTags
 * @property {string} version The version that the tag names.
 * @property {boolean} isPrerelease
 * @property {string[]} serverTags Full references that GoReleaser publishes.
 * @property {string[]} clientTags Full references that the workflow publishes.
 * @property {{majorMinor: string, latest: string, next: string}} skipPush
 *   Value for each `CHATTO_SKIP_PUSH_*` variable. See {@link SKIP_PUSH_ENV}.
 */

/**
 * Give the complete tag plan for one release tag.
 *
 * A prerelease has priority over `pushLatest`: a prerelease publishes `next`
 * and never publishes `latest`, even if the caller sets `pushLatest`. The
 * release workflow already computes `push_latest` as false for a prerelease,
 * so this rule only protects against a caller mistake.
 *
 * @param {object} input
 * @param {string} input.tag The release tag, with or without its `v` prefix.
 * @param {boolean|string} [input.pushLatest] True when this release is the
 *   highest stable version. The workflow computes this from the Git tags. The
 *   strings `"true"` and `"false"` are accepted, because the workflow supplies
 *   a step output.
 * @returns {ReleaseImageTags}
 * @throws {TypeError} If the tag is not a valid SemVer version, or if
 *   `pushLatest` is not a boolean or one of the two accepted strings.
 */
export function releaseImageTags({ tag, pushLatest = false }) {
  const { version, major, minor, prerelease } = parseReleaseTag(tag);
  const isPrerelease = prerelease !== "";
  const wantsLatest = asBoolean(pushLatest, "pushLatest");
  const majorMinor = `${major}.${minor}`;

  const serverNames = [version];
  const clientNames = [version];
  if (isPrerelease) {
    serverNames.push("next");
    clientNames.push("next");
  } else {
    serverNames.push(majorMinor);
    if (wantsLatest) {
      serverNames.push("latest");
      clientNames.push("latest");
    }
  }

  return {
    version,
    isPrerelease,
    serverTags: serverNames.map((name) => `${SERVER_IMAGE}:${name}`),
    clientTags: clientNames.map((name) => `${CLIENT_IMAGE}:${name}`),
    skipPush: {
      majorMinor: skipPushValue(serverNames, majorMinor),
      latest: skipPushValue(serverNames, "latest"),
      next: skipPushValue(serverNames, "next"),
    },
  };
}

/**
 * Give the GitHub Actions output lines for a tag plan.
 *
 * The output holds one key for each `CHATTO_SKIP_PUSH_*` variable, in lower
 * case, plus the two tag lists. The workflow uses `client_tags` to build the
 * client image. It keeps `server_tags` in the job log, where an operator can
 * see which tags the release moves.
 *
 * @param {ReleaseImageTags} plan
 * @returns {string} Text that ends with a newline.
 */
export function formatGithubOutput(plan) {
  const lines = [];
  for (const [key, name] of Object.entries(SKIP_PUSH_ENV)) {
    lines.push(`${name.toLowerCase()}=${plan.skipPush[key]}`);
  }
  lines.push(...multilineOutput("server_tags", plan.serverTags));
  lines.push(...multilineOutput("client_tags", plan.clientTags));
  return `${lines.join("\n")}\n`;
}

function multilineOutput(key, values) {
  return [`${key}<<${OUTPUT_DELIMITER}`, ...values, OUTPUT_DELIMITER];
}

function skipPushValue(publishedNames, name) {
  return publishedNames.includes(name) ? "false" : "true";
}

function asBoolean(value, name) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`Expected a boolean for ${name}, got: ${value}`);
}

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{tag: string, pushLatest: string|boolean}}
 * @throws {TypeError} If an option is unknown, or if `--tag` is absent.
 */
export function parseArgs(argv) {
  let tag;
  let pushLatest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--tag") {
      if (value === undefined) throw new TypeError("--tag needs a value");
      tag = value;
      index += 1;
    } else if (option === "--push-latest") {
      if (value === undefined) {
        throw new TypeError("--push-latest needs a value");
      }
      pushLatest = value;
      index += 1;
    } else {
      throw new TypeError(`Unknown option: ${option}`);
    }
  }
  if (tag === undefined) throw new TypeError("--tag is required");
  return { tag, pushLatest };
}

function main(argv) {
  try {
    process.stdout.write(formatGithubOutput(releaseImageTags(parseArgs(argv))));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.stderr.write(
      "usage: node tools/release-image-tags.mjs --tag <tag> [--push-latest <true|false>]\n",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}

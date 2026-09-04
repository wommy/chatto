import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLIENT_IMAGE,
  SERVER_IMAGE,
  formatGithubOutput,
  parseArgs,
  parseReleaseTag,
  releaseImageTags,
} from "./release-image-tags.mjs";

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const modulePath = path.join(repositoryRoot, "tools/release-image-tags.mjs");

/**
 * Give every reference that the workflow publishes for the client image.
 *
 * The plan holds the immutable tag and the floating tags separately, because
 * the workflow pushes the first and moves the second onto the digest that it
 * checked. The full list is this join, and no plan field stores it.
 *
 * @param {import("./release-image-tags.mjs").ReleaseImageTags} plan
 * @returns {string[]}
 */
function clientTags(plan) {
  return [plan.clientVersionTag, ...plan.clientFloatingTags];
}

/**
 * Give every reference that the release publishes for the server image.
 *
 * GoReleaser publishes the immutable tag itself; the release workflow moves
 * the floating tags onto it after the smoke check. The full list is this
 * join, and no plan field stores it. Mirrors {@link clientTags}.
 *
 * @param {import("./release-image-tags.mjs").ReleaseImageTags} plan
 * @returns {string[]}
 */
function serverTags(plan) {
  return [plan.serverVersionTag, ...plan.serverFloatingTags];
}

test("a stable highest release publishes version, major.minor and latest", () => {
  const plan = releaseImageTags({ tag: "v0.5.0", pushLatest: true });

  assert.equal(plan.version, "0.5.0");
  assert.equal(plan.isPrerelease, false);
  assert.deepEqual(serverTags(plan), [
    `${SERVER_IMAGE}:0.5.0`,
    `${SERVER_IMAGE}:0.5`,
    `${SERVER_IMAGE}:latest`,
  ]);
  assert.deepEqual(clientTags(plan), [
    `${CLIENT_IMAGE}:0.5.0`,
    `${CLIENT_IMAGE}:latest`,
  ]);
});

test("a stable release that is not the highest keeps latest where it is", () => {
  const plan = releaseImageTags({ tag: "v0.4.7", pushLatest: false });

  assert.deepEqual(serverTags(plan), [
    `${SERVER_IMAGE}:0.4.7`,
    `${SERVER_IMAGE}:0.4`,
  ]);
  assert.deepEqual(clientTags(plan), [`${CLIENT_IMAGE}:0.4.7`]);
});

test("a prerelease publishes version and next only", () => {
  const plan = releaseImageTags({ tag: "v0.5.0-alpha.1" });

  assert.equal(plan.isPrerelease, true);
  assert.deepEqual(serverTags(plan), [
    `${SERVER_IMAGE}:0.5.0-alpha.1`,
    `${SERVER_IMAGE}:next`,
  ]);
  assert.deepEqual(clientTags(plan), [
    `${CLIENT_IMAGE}:0.5.0-alpha.1`,
    `${CLIENT_IMAGE}:next`,
  ]);
});

test("a prerelease never moves latest, even when the caller asks", () => {
  const plan = releaseImageTags({ tag: "v0.5.0-alpha.1", pushLatest: true });

  assert.ok(!serverTags(plan).includes(`${SERVER_IMAGE}:latest`));
  assert.ok(!clientTags(plan).includes(`${CLIENT_IMAGE}:latest`));
});

test("the client image gets no major.minor tag", () => {
  // Today's releases publish no `chatto-client:{major}.{minor}` tag. To add
  // it is a change of behaviour, and issue #43 keeps it out of the change
  // that made this module. This test fails if the tag appears by accident.
  for (const tag of ["v1.2.3", "v0.5.0", "v2.0.0-rc.1"]) {
    const plan = releaseImageTags({ tag, pushLatest: true });
    const { major, minor } = parseReleaseTag(tag);
    assert.ok(!clientTags(plan).includes(`${CLIENT_IMAGE}:${major}.${minor}`));
  }
});

test("the v prefix makes no difference to the plan", () => {
  assert.deepEqual(
    releaseImageTags({ tag: "v1.2.3", pushLatest: true }),
    releaseImageTags({ tag: "1.2.3", pushLatest: true }),
  );
});

test("push-latest accepts the string that a workflow step supplies", () => {
  assert.deepEqual(
    releaseImageTags({ tag: "v1.2.3", pushLatest: "true" }),
    releaseImageTags({ tag: "v1.2.3", pushLatest: true }),
  );
  assert.deepEqual(
    releaseImageTags({ tag: "v1.2.3", pushLatest: "false" }),
    releaseImageTags({ tag: "v1.2.3", pushLatest: false }),
  );
  assert.throws(
    () => releaseImageTags({ tag: "v1.2.3", pushLatest: "yes" }),
    TypeError,
  );
});

test("build metadata is not a prerelease", () => {
  // SemVer keeps the prerelease and the build metadata apart, and so does the
  // parse that GoReleaser uses. A substring test for `-` does not. Issue #41
  // owns the other places that still use a substring test. No Chatto release
  // has used build metadata, and Docker refuses a `+` in a tag, so this test
  // pins the classification and nothing more.
  const parsed = parseReleaseTag("v1.0.0+build.1");

  assert.equal(parsed.prerelease, "");
  assert.equal(parsed.build, "build.1");
  assert.equal(releaseImageTags({ tag: "v1.0.0+build.1" }).isPrerelease, false);
});

test("an invalid tag is refused", () => {
  for (const tag of ["", "v", "1.2", "1.2.3.4", "v01.2.3", "release-1.2.3"]) {
    assert.throws(() => parseReleaseTag(tag), TypeError, `accepted: ${tag}`);
  }
});

test("the command line needs a tag and refuses an unknown option", () => {
  assert.deepEqual(parseArgs(["--tag", "v1.2.3"]), {
    tag: "v1.2.3",
    pushLatest: false,
  });
  assert.deepEqual(parseArgs(["--tag", "v1.2.3", "--push-latest", "true"]), {
    tag: "v1.2.3",
    pushLatest: "true",
  });
  assert.throws(() => parseArgs([]), TypeError);
  assert.throws(() => parseArgs(["--tag"]), TypeError);
  assert.throws(() => parseArgs(["--branch", "main"]), TypeError);
});

test("the output holds the version tag and the floating tags for both images", () => {
  const output = formatGithubOutput(
    releaseImageTags({ tag: "v0.5.0", pushLatest: true }),
  );

  assert.equal(
    output,
    [
      "version=0.5.0",
      `server_version_tag=${SERVER_IMAGE}:0.5.0`,
      "server_floating_tags<<CHATTO_IMAGE_TAGS",
      `${SERVER_IMAGE}:0.5`,
      `${SERVER_IMAGE}:latest`,
      "CHATTO_IMAGE_TAGS",
      `client_version_tag=${CLIENT_IMAGE}:0.5.0`,
      "client_floating_tags<<CHATTO_IMAGE_TAGS",
      `${CLIENT_IMAGE}:latest`,
      "CHATTO_IMAGE_TAGS",
      "",
    ].join("\n"),
  );
});

test("the client tags are split into the version tag and the floating tags", () => {
  // `docker buildx imagetools create` takes the source reference and the
  // target references apart, and the release workflow must not filter the tag
  // list itself. To filter it in the workflow is to make a second copy of the
  // policy in a place that no test reaches.
  const stable = releaseImageTags({ tag: "v0.5.0", pushLatest: true });
  assert.equal(stable.clientVersionTag, `${CLIENT_IMAGE}:0.5.0`);
  assert.deepEqual(stable.clientFloatingTags, [`${CLIENT_IMAGE}:latest`]);

  const prerelease = releaseImageTags({ tag: "v0.5.0-alpha.1" });
  assert.equal(prerelease.clientVersionTag, `${CLIENT_IMAGE}:0.5.0-alpha.1`);
  assert.deepEqual(prerelease.clientFloatingTags, [`${CLIENT_IMAGE}:next`]);

  const older = releaseImageTags({ tag: "v0.4.7", pushLatest: false });
  assert.equal(older.clientVersionTag, `${CLIENT_IMAGE}:0.4.7`);
  assert.deepEqual(older.clientFloatingTags, []);
});

test("the server tags are split into the version tag and the floating tags", () => {
  // Mirrors the client split above. GoReleaser publishes serverVersionTag
  // itself; the release workflow moves serverFloatingTags onto it after the
  // smoke check, with the same `docker buildx imagetools create` command.
  const stable = releaseImageTags({ tag: "v0.5.0", pushLatest: true });
  assert.equal(stable.serverVersionTag, `${SERVER_IMAGE}:0.5.0`);
  assert.deepEqual(stable.serverFloatingTags, [
    `${SERVER_IMAGE}:0.5`,
    `${SERVER_IMAGE}:latest`,
  ]);

  const prerelease = releaseImageTags({ tag: "v0.5.0-alpha.1" });
  assert.equal(prerelease.serverVersionTag, `${SERVER_IMAGE}:0.5.0-alpha.1`);
  assert.deepEqual(prerelease.serverFloatingTags, [`${SERVER_IMAGE}:next`]);

  const older = releaseImageTags({ tag: "v0.4.7", pushLatest: false });
  assert.equal(older.serverVersionTag, `${SERVER_IMAGE}:0.4.7`);
  assert.deepEqual(older.serverFloatingTags, [`${SERVER_IMAGE}:0.4`]);
});

test("an empty floating-tag list gives an empty output value, per image", () => {
  // A stable release that is not the highest version publishes the version
  // tag only for the client's `latest`, but the server still floats
  // `{major}.{minor}`. The tag-move step then moves what the plan lists for
  // each image, and nothing more, and it must stay green even when one
  // image's list is empty while the other's is not.
  const output = formatGithubOutput(
    releaseImageTags({ tag: "v0.4.7", pushLatest: false }),
  );

  assert.match(
    output,
    /client_floating_tags<<CHATTO_IMAGE_TAGS\nCHATTO_IMAGE_TAGS\n$/,
  );
  assert.match(
    output,
    /server_floating_tags<<CHATTO_IMAGE_TAGS\n.*:0\.4\nCHATTO_IMAGE_TAGS/,
  );
});

test("the command writes the output of a prerelease to stdout", () => {
  const stdout = execFileSync(
    process.execPath,
    [modulePath, "--tag", "v0.5.0-alpha.2", "--push-latest", "false"],
    { encoding: "utf8" },
  );

  assert.equal(
    stdout,
    formatGithubOutput(releaseImageTags({ tag: "v0.5.0-alpha.2" })),
  );
});

test("the command fails on a tag that it cannot parse", () => {
  assert.throws(() =>
    execFileSync(process.execPath, [modulePath, "--tag", "nightly"], {
      encoding: "utf8",
      stdio: "pipe",
    }),
  );
});

test("goreleaser skips every floating server manifest unconditionally", () => {
  // Issue #52: nothing evaluates a GoReleaser template before the push that
  // acts on it, and GoReleaser pushes before the release workflow creates the
  // GitHub Release. A condition here, bare variable or not, is a decision
  // that no test can reach and that runs before the release can fail loud.
  // `.goreleaser.yml` must therefore skip every floating manifest with the
  // literal string "true", and this module's server_floating_tags output is
  // the only place that decides which of them the workflow moves.
  const configuration = readFileSync(
    path.join(repositoryRoot, ".goreleaser.yml"),
    "utf8",
  );
  // Drop comment-only lines first. A prose comment can mention `skip_push:`
  // in its explanation, and that must not look like a YAML key to the parser
  // below.
  const withoutComments = configuration
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const manifestBlocks = withoutComments.split(/(?=- name_template:)/).slice(1);
  const manifests = manifestBlocks.map((block) => {
    const nameMatch = /name_template:\s*"(.+)"/.exec(block);
    const skipMatch = /^\s+skip_push:\s*(.+)$/m.exec(block);
    return { name: nameMatch[1], skipPush: skipMatch ? skipMatch[1].trim() : undefined };
  });

  const version = manifests.find(
    (manifest) => manifest.name === `${SERVER_IMAGE}:{{ .Version }}`,
  );
  assert.ok(version, "the version manifest must exist");
  assert.equal(
    version.skipPush,
    undefined,
    "the version manifest must stay unskipped",
  );

  const floating = manifests.filter(
    (manifest) => manifest.name !== `${SERVER_IMAGE}:{{ .Version }}`,
  );
  assert.equal(floating.length, 3, "every floating server manifest must be present");
  for (const manifest of floating) {
    assert.equal(
      manifest.skipPush,
      '"true"',
      `${manifest.name} must set skip_push to the literal string "true", found: ${manifest.skipPush}`,
    );
  }
});

test("the documented tag table names exactly the tags that the policy publishes", () => {
  // docs/RELEASING.md holds the table that a releaser reads. The module holds
  // the same policy as data. This asserts that the two name the same tags, so
  // that a new row in one is not forgotten in the other. It does not compare
  // the wording of a cell, which an editor may improve freely.
  const document = readFileSync(
    path.join(repositoryRoot, "docs/RELEASING.md"),
    "utf8",
  );
  const section = /## Container image tags\n([\s\S]*?)\n## /.exec(document);
  assert.ok(section, "docs/RELEASING.md must hold a container image tag section");

  const documented = new Set(
    [...section[1].matchAll(/^\| `([^`]+)`\s*\|/gm)].map((match) => match[1]),
  );

  // The table names every tag that any release publishes, so the comparison
  // needs both a stable release and a prerelease: `latest` and `1.2` come
  // from the first, `next` from the second.
  const tagsOf = (plan) =>
    [...serverTags(plan), plan.clientVersionTag, ...plan.clientFloatingTags].map(
      (reference) => reference.split(":").pop(),
    );
  const published = new Set([
    ...tagsOf(releaseImageTags({ tag: "v1.2.3", pushLatest: true })),
    ...tagsOf(releaseImageTags({ tag: "v1.2.3-rc.1" })),
  ]);
  // The prerelease plan names its own version; the table gives the stable one.
  published.delete("1.2.3-rc.1");

  assert.deepEqual(
    documented,
    published,
    "docs/RELEASING.md and the policy table must name the same tags",
  );
});


test("goreleaser publishes the server manifests that the policy names", () => {
  const configuration = readFileSync(
    path.join(repositoryRoot, ".goreleaser.yml"),
    "utf8",
  );
  const manifests = [
    ...configuration.matchAll(/^\s*- name_template:\s*"(.+)"$/gm),
  ].map((match) => match[1]);

  assert.deepEqual(manifests, [
    `${SERVER_IMAGE}:{{ .Version }}`,
    `${SERVER_IMAGE}:{{ .Major }}.{{ .Minor }}`,
    `${SERVER_IMAGE}:latest`,
    `${SERVER_IMAGE}:next`,
  ]);
});

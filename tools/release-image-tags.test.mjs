import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLIENT_IMAGE,
  SERVER_IMAGE,
  SKIP_PUSH_ENV,
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

test("a stable highest release publishes version, major.minor and latest", () => {
  const plan = releaseImageTags({ tag: "v0.5.0", pushLatest: true });

  assert.equal(plan.version, "0.5.0");
  assert.equal(plan.isPrerelease, false);
  assert.deepEqual(plan.serverTags, [
    `${SERVER_IMAGE}:0.5.0`,
    `${SERVER_IMAGE}:0.5`,
    `${SERVER_IMAGE}:latest`,
  ]);
  assert.deepEqual(clientTags(plan), [
    `${CLIENT_IMAGE}:0.5.0`,
    `${CLIENT_IMAGE}:latest`,
  ]);
  assert.deepEqual(plan.skipPush, {
    majorMinor: "false",
    latest: "false",
    next: "true",
  });
});

test("a stable release that is not the highest keeps latest where it is", () => {
  const plan = releaseImageTags({ tag: "v0.4.7", pushLatest: false });

  assert.deepEqual(plan.serverTags, [
    `${SERVER_IMAGE}:0.4.7`,
    `${SERVER_IMAGE}:0.4`,
  ]);
  assert.deepEqual(clientTags(plan), [`${CLIENT_IMAGE}:0.4.7`]);
  assert.deepEqual(plan.skipPush, {
    majorMinor: "false",
    latest: "true",
    next: "true",
  });
});

test("a prerelease publishes version and next only", () => {
  const plan = releaseImageTags({ tag: "v0.5.0-alpha.1" });

  assert.equal(plan.isPrerelease, true);
  assert.deepEqual(plan.serverTags, [
    `${SERVER_IMAGE}:0.5.0-alpha.1`,
    `${SERVER_IMAGE}:next`,
  ]);
  assert.deepEqual(clientTags(plan), [
    `${CLIENT_IMAGE}:0.5.0-alpha.1`,
    `${CLIENT_IMAGE}:next`,
  ]);
  assert.deepEqual(plan.skipPush, {
    majorMinor: "true",
    latest: "true",
    next: "false",
  });
});

test("a prerelease never moves latest, even when the caller asks", () => {
  const plan = releaseImageTags({ tag: "v0.5.0-alpha.1", pushLatest: true });

  assert.equal(plan.skipPush.latest, "true");
  assert.ok(!plan.serverTags.includes(`${SERVER_IMAGE}:latest`));
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

test("the output holds the version and one key for each skip_push variable", () => {
  const output = formatGithubOutput(
    releaseImageTags({ tag: "v0.5.0", pushLatest: true }),
  );

  assert.equal(
    output,
    [
      "version=0.5.0",
      "chatto_skip_push_major_minor=false",
      "chatto_skip_push_latest=false",
      "chatto_skip_push_next=true",
      `client_version_tag=${CLIENT_IMAGE}:0.5.0`,
      `client_floating_tags=${CLIENT_IMAGE}:latest`,
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

test("a release with no floating client tag gives an empty output value", () => {
  // A stable release that is not the highest version publishes the version
  // tag only. The tag-move step then moves nothing, and it must stay green.
  const output = formatGithubOutput(
    releaseImageTags({ tag: "v0.4.7", pushLatest: false }),
  );

  assert.match(output, /client_floating_tags=\n$/);
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

test("goreleaser reads every skip_push value and computes none", () => {
  // `.goreleaser.yml` must stay a passthrough. A condition in a template is a
  // decision that no test can reach, because nothing evaluates a GoReleaser
  // template before the push that acts on it.
  const configuration = readFileSync(
    path.join(repositoryRoot, ".goreleaser.yml"),
    "utf8",
  );
  const templates = [...configuration.matchAll(/^\s*skip_push:\s*(.+)$/gm)].map(
    (match) => match[1].trim(),
  );
  const names = new Set();

  for (const template of templates) {
    const match = /^'\{\{ \.Env\.([A-Z_]+) \}\}'$/.exec(template);
    assert.ok(match, `skip_push must be a bare variable, found: ${template}`);
    names.add(match[1]);
  }

  assert.deepEqual(names, new Set(Object.values(SKIP_PUSH_ENV)));
});

test("the release workflow sets every skip_push variable that goreleaser reads", () => {
  // GoReleaser templates use `missingkey=error`, so an unset variable fails
  // the manifest push in the middle of a release, after images are pushed.
  // The test above proves `.goreleaser.yml` reads these names; this one
  // proves the workflow supplies them.
  const workflow = readFileSync(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );

  for (const name of Object.values(SKIP_PUSH_ENV)) {
    assert.match(
      workflow,
      new RegExp(`^\\s*${name}:\\s*\\S`, "m"),
      `.github/workflows/release.yml must set ${name} for GoReleaser`,
    );
  }
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

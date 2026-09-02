import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEAD_ALLOWLIST_PATHS,
  DEFAULT_CONFIG_PATH,
  DEFAULT_MANIFEST_PATH,
  ReleaseTagRefusal,
  formatGithubOutput,
  parseArgs,
  readReleasePleaseConfig,
  releasePleaseAllowlist,
  verifyReleaseTag,
} from "./verify-release-tag.mjs";
import { releaseImageTags } from "./release-image-tags.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = path.join(repositoryRoot, "tools/verify-release-tag.mjs");

/**
 * The seven paths that the release workflow script listed before this module
 * held them. This module must accept and refuse exactly what that script
 * accepted and refused, so the derived allowlist must equal this set. Two of
 * the seven name files that the repository does not hold; see
 * `DEAD_ALLOWLIST_PATHS`.
 */
const WORKFLOW_ALLOWLIST = [
  ".release-please-config.json",
  ".release-please-config-main.json",
  ".release-please-manifest.json",
  ".release-please-manifest-main.json",
  "CHANGELOG.md",
  "cli/version.go",
  "apps/frontend/package.json",
];

// Keep the fixtures away from the configuration of the person or the runner
// that runs the test. The dates are fixed so that a fixture repository is the
// same on every run.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Release Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Release Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+00:00",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+00:00",
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

const FIXTURE_CONFIG = {
  packages: {
    ".": {
      "package-name": "chatto",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [
        { type: "generic", path: "cli/version.go" },
        { type: "json", path: "apps/frontend/package.json", jsonpath: "$.version" },
      ],
    },
  },
};

const FIXTURE_ALLOWLIST = releasePleaseAllowlist({
  config: FIXTURE_CONFIG,
  configPath: DEFAULT_CONFIG_PATH,
  manifestPath: DEFAULT_MANIFEST_PATH,
});

/**
 * Make a Git repository that looks like Chatto at a release.
 *
 * It needs no network and no daemon. `git update-ref` writes the
 * `refs/remotes/origin/*` refs that the gate reads, which is what a fetch
 * would leave behind.
 *
 * @param {import("node:test").TestContext} t
 * @returns {{dir: string, commit: (files: Record<string, string>, message: string) => string, setRemoteBranch: (name: string, commit: string) => void, tag: (name: string, commit: string) => void, base: string}}
 */
function createRepository(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-release-tag-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);

  const repository = {
    dir,
    commit(files, message) {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "--quiet", "-m", message]);
      return git(dir, ["rev-parse", "HEAD"]);
    },
    setRemoteBranch(name, commit) {
      git(dir, ["update-ref", `refs/remotes/origin/${name}`, commit]);
    },
    tag(name, commit) {
      git(dir, ["tag", name, commit]);
    },
  };

  repository.base = repository.commit(
    {
      "README.md": "fixture\n",
      [DEFAULT_CONFIG_PATH]: `${JSON.stringify(FIXTURE_CONFIG, null, 2)}\n`,
      [DEFAULT_MANIFEST_PATH]: '{ ".": "0.4.9" }\n',
      "CHANGELOG.md": "# Changelog\n",
      "cli/version.go": 'package cli\n\nvar Version = "0.4.9"\n',
      "apps/frontend/package.json": '{ "version": "0.4.9" }\n',
    },
    "chore: base",
  );
  return repository;
}

/** Make the commit that a release-please pull request merges. */
function releaseCommit(repository, version) {
  return repository.commit(
    {
      "CHANGELOG.md": `# Changelog\n\n## ${version}\n`,
      "cli/version.go": `package cli\n\nvar Version = "${version}"\n`,
      "apps/frontend/package.json": `{ "version": "${version}" }\n`,
      [DEFAULT_MANIFEST_PATH]: `{ ".": "${version}" }\n`,
    },
    `chore(main): release ${version}`,
  );
}

function verify(repository, tag) {
  return verifyReleaseTag({ tag, allowlist: FIXTURE_ALLOWLIST, cwd: repository.dir });
}

// ---------------------------------------------------------------------------
// The allowlist comes from the release-please configuration
// ---------------------------------------------------------------------------

test("the allowlist derived from the real configuration equals the workflow list", () => {
  // This is the behaviour test for the structural move. The workflow script
  // wrote these seven paths by hand; the module derives five of them from
  // `.release-please-config.json` and carries the two dead ones. The two lists
  // must hold the same paths, or the gate accepts or refuses something new.
  const allowlist = releasePleaseAllowlist({
    config: readReleasePleaseConfig(DEFAULT_CONFIG_PATH, { cwd: repositoryRoot }),
    configPath: DEFAULT_CONFIG_PATH,
    manifestPath: DEFAULT_MANIFEST_PATH,
  });

  assert.deepEqual([...allowlist].sort(), [...WORKFLOW_ALLOWLIST].sort());
});

test("the two dead entries stay until their own change removes them", () => {
  // The gate fails closed, so an entry that matches no file makes the gate
  // stricter. To remove one changes what the gate accepts, which is a change
  // of behaviour and not a structural move. This test fails if somebody drops
  // them inside another change.
  assert.deepEqual(DEAD_ALLOWLIST_PATHS, [
    ".release-please-config-main.json",
    ".release-please-manifest-main.json",
  ]);
  const allowlist = releasePleaseAllowlist({
    config: FIXTURE_CONFIG,
    configPath: DEFAULT_CONFIG_PATH,
    manifestPath: DEFAULT_MANIFEST_PATH,
  });
  for (const dead of DEAD_ALLOWLIST_PATHS) assert.ok(allowlist.includes(dead));
});

test("a new extra-files entry reaches the allowlist with no second edit", () => {
  const allowlist = releasePleaseAllowlist({
    config: {
      packages: {
        ".": {
          "changelog-path": "CHANGELOG.md",
          "extra-files": [
            { type: "generic", path: "cli/version.go" },
            "apps/desktop/version.txt",
          ],
        },
      },
    },
    configPath: DEFAULT_CONFIG_PATH,
    manifestPath: DEFAULT_MANIFEST_PATH,
  });

  assert.ok(allowlist.includes("cli/version.go"));
  // release-please accepts a plain string for an `extra-files` entry.
  assert.ok(allowlist.includes("apps/desktop/version.txt"));
});

test("the allowlist holds the configuration and the manifest that the caller names", () => {
  const allowlist = releasePleaseAllowlist({
    config: { packages: { ".": {} } },
    configPath: "release/config.json",
    manifestPath: "release/manifest.json",
  });

  assert.ok(allowlist.includes("release/config.json"));
  assert.ok(allowlist.includes("release/manifest.json"));
  // A package with no `changelog-path` uses release-please's own default.
  assert.ok(allowlist.includes("CHANGELOG.md"));
});

test("the allowlist holds no duplicate", () => {
  const allowlist = releasePleaseAllowlist({
    config: { packages: { ".": { "changelog-path": "CHANGELOG.md" } } },
    configPath: "CHANGELOG.md",
    manifestPath: DEFAULT_MANIFEST_PATH,
  });

  assert.equal(new Set(allowlist).size, allowlist.length);
});

test("a configuration with no root package is refused", () => {
  assert.throws(
    () =>
      releasePleaseAllowlist({
        config: { packages: { "apps/desktop": {} } },
        configPath: DEFAULT_CONFIG_PATH,
        manifestPath: DEFAULT_MANIFEST_PATH,
      }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// Rule 1: the tagged commit is reachable from a release branch
// ---------------------------------------------------------------------------

test("a tag on a commit that origin/main holds is accepted", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5.0");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.5.0", release);

  const verdict = verify(repository, "v0.5.0");

  assert.equal(verdict.sourceBranch, "main");
  assert.equal(verdict.commit, release);
  assert.equal(verdict.version, "0.5.0");
  assert.equal(verdict.isStable, true);
});

test("a tag on a commit that an origin/release-* branch holds is accepted", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.4.10");
  // `origin/main` stays behind, so only the release branch holds the commit.
  repository.setRemoteBranch("main", repository.base);
  repository.setRemoteBranch("release-0.4", release);
  repository.tag("v0.4.10", release);

  assert.equal(verify(repository, "v0.4.10").sourceBranch, "release-0.4");
});

test("a tag on a commit that no release branch holds is refused", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5.0");
  // Both remote branches stay at the base commit, so the tagged commit is on
  // no release branch. This is the hand-pushed tag that the gate exists for.
  repository.setRemoteBranch("main", repository.base);
  repository.setRemoteBranch("release-0.4", repository.base);
  repository.tag("v0.5.0", release);

  assert.throws(() => verify(repository, "v0.5.0"), (error) => {
    assert.ok(error instanceof ReleaseTagRefusal);
    assert.match(error.message, /not reachable from origin\/main or an origin\/release-\* branch/);
    return true;
  });
});

test("a repository with no remote branch at all refuses the tag", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5.0");
  repository.tag("v0.5.0", release);

  assert.throws(() => verify(repository, "v0.5.0"), ReleaseTagRefusal);
});

// ---------------------------------------------------------------------------
// Rule 2: the tagged commit has a parent
// ---------------------------------------------------------------------------

test("a tag on a parentless commit is refused", (t) => {
  const repository = createRepository(t);
  repository.setRemoteBranch("main", repository.base);
  repository.tag("v0.5.0", repository.base);

  assert.throws(() => verify(repository, "v0.5.0"), (error) => {
    assert.ok(error instanceof ReleaseTagRefusal);
    assert.match(error.message, /has no parent to compare against/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Rule 3: the tagged commit changes release-please files only
// ---------------------------------------------------------------------------

test("a release commit that also changes product code is refused", (t) => {
  const repository = createRepository(t);
  const release = repository.commit(
    {
      "CHANGELOG.md": "# Changelog\n\n## 0.5.0\n",
      "cli/version.go": 'package cli\n\nvar Version = "0.5.0"\n',
      "cli/internal/core/room.go": "package core\n",
    },
    "chore(main): release 0.5.0",
  );
  repository.setRemoteBranch("main", release);
  repository.tag("v0.5.0", release);

  assert.throws(() => verify(repository, "v0.5.0"), (error) => {
    assert.ok(error instanceof ReleaseTagRefusal);
    assert.match(error.message, /contains non-release-please files/);
    assert.deepEqual(error.details, ["Disallowed file: cli/internal/core/room.go"]);
    return true;
  });
});

test("every disallowed path reaches the refusal, not only the first", (t) => {
  const repository = createRepository(t);
  const release = repository.commit(
    {
      "CHANGELOG.md": "# Changelog\n\n## 0.5.0\n",
      "cli/main.go": "package main\n",
      "docs/RELEASING.md": "# Releasing\n",
    },
    "chore(main): release 0.5.0",
  );
  repository.setRemoteBranch("main", release);
  repository.tag("v0.5.0", release);

  assert.throws(() => verify(repository, "v0.5.0"), (error) => {
    assert.deepEqual(error.details, [
      "Disallowed file: cli/main.go",
      "Disallowed file: docs/RELEASING.md",
    ]);
    return true;
  });
});

test("a commit that changes only the allowlisted paths is accepted", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5.0");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.5.0", release);

  assert.equal(verify(repository, "v0.5.0").version, "0.5.0");
});

// ---------------------------------------------------------------------------
// Rule 4: `latest` moves for the highest stable version only
// ---------------------------------------------------------------------------

test("the highest stable release moves latest", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5.0");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v0.5.0", release);

  const verdict = verify(repository, "v0.5.0");

  assert.equal(verdict.isStable, true);
  assert.equal(verdict.pushLatest, true);
});

test("a stable patch for an older series does not move latest", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.4.10");
  repository.setRemoteBranch("main", repository.base);
  repository.setRemoteBranch("release-0.4", release);
  repository.tag("v0.5.0", repository.base);
  repository.tag("v0.4.10", release);

  const verdict = verify(repository, "v0.4.10");

  assert.equal(verdict.isStable, true);
  assert.equal(verdict.pushLatest, false);
});

test("versions are compared by number, so 0.4.10 follows 0.4.9", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.4.10");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v0.4.10", release);

  // Text order puts `0.4.9` last and would keep `latest` where it is.
  assert.equal(verify(repository, "v0.4.10").pushLatest, true);
});

test("a prerelease is not stable and never moves latest", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.6.0-alpha.1");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.5.0", repository.base);
  repository.tag("v0.6.0-alpha.1", release);

  const verdict = verify(repository, "v0.6.0-alpha.1");

  assert.equal(verdict.isStable, false);
  assert.equal(verdict.pushLatest, false);
});

test("a prerelease tag is no candidate for the highest stable version", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5.0");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.6.0-alpha.1", repository.base);
  repository.tag("v0.5.0", release);

  assert.equal(verify(repository, "v0.5.0").pushLatest, true);
});

test("a tag that is no SemVer version is refused", (t) => {
  // `v0.5` was stable to the substring test, and the pattern for a stable tag
  // did not match it. With one other stable tag in the repository the gate
  // accepted it and called it stable. `parseReleaseTag` refuses it, so the
  // gate refuses the release.
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v0.5", release);

  assert.throws(() => verify(repository, "v0.5"), (error) => {
    assert.ok(error instanceof ReleaseTagRefusal);
    assert.match(error.message, /the tag is not a valid SemVer version/);
    return true;
  });
});

test("a stable tag with no stable version to compare against is refused", (t) => {
  // A version that carries build metadata is stable, and the pattern for a
  // stable candidate does not match it. With no other stable tag the sorted
  // list is empty, and rule 4 cannot answer. The gate refuses rather than
  // guess. The substring test never reached this branch for such a tag,
  // because it called the version a prerelease and stopped.
  const repository = createRepository(t);
  const release = releaseCommit(repository, "1.0.0+build-1");
  repository.setRemoteBranch("main", release);
  repository.tag("v1.0.0+build-1", release);

  assert.throws(() => verify(repository, "v1.0.0+build-1"), (error) => {
    assert.ok(error instanceof ReleaseTagRefusal);
    assert.match(error.message, /holds no stable release tag/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// One parser answers "is this a prerelease?"
// ---------------------------------------------------------------------------

test("build metadata does not make a stable version a prerelease", (t) => {
  // This is the case that the substring test got wrong. SemVer keeps the
  // prerelease and the build metadata in separate fields, and the metadata
  // after `+` holds a `-` here. `!version.includes("-")` called this version
  // a prerelease; `parseReleaseTag` calls it stable, which agrees with the
  // Docker tag policy and with GoReleaser.
  const repository = createRepository(t);
  const release = releaseCommit(repository, "1.0.0+build-1");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v1.0.0+build-1", release);

  const verdict = verify(repository, "v1.0.0+build-1");

  assert.equal(verdict.version, "1.0.0+build-1");
  assert.equal(verdict.isStable, true);
  // The substring test that this replaces gave the opposite answer.
  assert.equal(!verdict.version.includes("-"), false);
});

test("a stable version with build metadata does not move latest", (t) => {
  // `highestStableVersion` selects candidates with a pattern of three
  // numbers, so a tag with build metadata is no candidate and the equality
  // test cannot hold. The release is stable and `latest` stays where it is.
  // This is the safe direction, and Docker refuses a `+` character in a tag,
  // so such a release publishes no image. This test pins the behaviour so
  // that a change to it shows in a diff.
  const repository = createRepository(t);
  const release = releaseCommit(repository, "1.0.0+build-1");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v1.0.0+build-1", release);

  const verdict = verify(repository, "v1.0.0+build-1");

  assert.equal(verdict.isStable, true);
  assert.equal(verdict.pushLatest, false);
});

test("build metadata on a prerelease keeps the version a prerelease", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "1.0.0-rc.1+build-1");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v1.0.0-rc.1+build-1", release);

  const verdict = verify(repository, "v1.0.0-rc.1+build-1");

  assert.equal(verdict.isStable, false);
  assert.equal(verdict.pushLatest, false);
});

test("the gate and the Docker tag policy read one parser", (t) => {
  // `releaseImageTags` owns the tag policy, and this gate owns `is_stable`.
  // The two must not disagree about a version. `isPrerelease` and `isStable`
  // are the same answer with opposite signs.
  const repository = createRepository(t);
  const release = releaseCommit(repository, "1.0.0+build-1");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v1.0.0+build-1", release);

  const verdict = verify(repository, "v1.0.0+build-1");
  const plan = releaseImageTags({ tag: "v1.0.0+build-1" });

  assert.equal(verdict.isStable, !plan.isPrerelease);
  assert.equal(verdict.version, plan.version);
});

// ---------------------------------------------------------------------------
// Output and command line
// ---------------------------------------------------------------------------

test("the output holds the two values that the release job reads", () => {
  assert.equal(
    formatGithubOutput({ pushLatest: true, isStable: true }),
    "push_latest=true\nis_stable=true\n",
  );
  assert.equal(
    formatGithubOutput({ pushLatest: false, isStable: false }),
    "push_latest=false\nis_stable=false\n",
  );
});

test("the command line needs a tag and refuses an unknown option", () => {
  assert.deepEqual(parseArgs(["--tag", "v1.2.3"]), {
    tag: "v1.2.3",
    configPath: DEFAULT_CONFIG_PATH,
    manifestPath: DEFAULT_MANIFEST_PATH,
  });
  assert.deepEqual(
    parseArgs(["--tag", "v1.2.3", "--config", "c.json", "--manifest", "m.json"]),
    { tag: "v1.2.3", configPath: "c.json", manifestPath: "m.json" },
  );
  assert.throws(() => parseArgs([]), TypeError);
  assert.throws(() => parseArgs(["--tag"]), TypeError);
  assert.throws(() => parseArgs(["--config"]), TypeError);
  assert.throws(() => parseArgs(["--branch", "main"]), TypeError);
});

test("the command writes the outputs of an accepted tag to stdout", (t) => {
  const repository = createRepository(t);
  const release = releaseCommit(repository, "0.5.0");
  repository.setRemoteBranch("main", release);
  repository.tag("v0.4.9", repository.base);
  repository.tag("v0.5.0", release);

  const stdout = execFileSync(process.execPath, [modulePath, "--tag", "v0.5.0"], {
    cwd: repository.dir,
    env: GIT_ENV,
    encoding: "utf8",
  });

  assert.equal(stdout, "push_latest=true\nis_stable=true\n");
});

test("the command exits non-zero and annotates the refusal", (t) => {
  const repository = createRepository(t);
  const release = repository.commit(
    { "CHANGELOG.md": "# Changelog\n", "cli/main.go": "package main\n" },
    "chore(main): release 0.5.0",
  );
  repository.setRemoteBranch("main", release);
  repository.tag("v0.5.0", release);

  let failure;
  try {
    execFileSync(process.execPath, [modulePath, "--tag", "v0.5.0"], {
      cwd: repository.dir,
      env: GIT_ENV,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure, "the command must fail on a refused tag");
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /^::error::Refusing to release v0\.5\.0/m);
  assert.match(failure.stderr, /Disallowed file: cli\/main\.go/);
  assert.equal(failure.stdout, "");
});

test("the command fails on a tag that the repository does not hold", (t) => {
  const repository = createRepository(t);
  repository.setRemoteBranch("main", repository.base);

  assert.throws(() =>
    execFileSync(process.execPath, [modulePath, "--tag", "v9.9.9"], {
      cwd: repository.dir,
      env: GIT_ENV,
      encoding: "utf8",
      stdio: "pipe",
    }),
  );
});

test("the module reads the release-please configuration of the repository", () => {
  // The gate runs against the tree of the tagged commit, so the allowlist is
  // the one that the released commit declares.
  const config = readReleasePleaseConfig(DEFAULT_CONFIG_PATH, { cwd: repositoryRoot });

  assert.equal(config.packages["."]["changelog-path"], "CHANGELOG.md");
  assert.equal(
    readFileSync(path.join(repositoryRoot, DEFAULT_MANIFEST_PATH), "utf8").length > 0,
    true,
  );
});

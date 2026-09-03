# Releasing Chatto

Chatto uses release-please to prepare alpha releases from `main`. Stable releases
and maintenance patches come from `release-x.y` branches. Each branch uses the
same `.release-please-config.json` and `.release-please-manifest.json` paths; the
configuration committed to that branch determines whether it produces
prereleases or stable releases.

## Documentation channels

The public documentation has two independently deployed channels:

- `https://docs.chatto.run` serves the highest stable Chatto release.
- `https://dev-docs.chatto.run` serves the newest documentation build from
  `main`.

Relevant pushes to `main` publish an immutable docs image tagged as
`main-<UTC timestamp>-<short SHA>`. Flux deploys the newest sortable tag to the
development docs site. The site identifies itself as unreleased, displays the
source revision, and opts out of search indexing.

After a stable `vX.Y.Z` release completes successfully, the release workflow
builds the docs from that exact tag and publishes
`ghcr.io/chattocorp/chatto-docs:vX.Y.Z`. Flux selects the highest stable SemVer
tag for `docs.chatto.run`. Prerelease tags never update the stable docs site.

Stable docs images are immutable release snapshots. Corrections to the stable
documentation ship with the next Chatto patch release rather than replacing an
existing `vX.Y.Z` image.

## Container image tags

A release publishes two images: `ghcr.io/chattocorp/chatto` (the server) and
`ghcr.io/chattocorp/chatto-client` (the frontend).

| Tag         | `chatto`                   | `chatto-client`            |
| ----------- | -------------------------- | -------------------------- |
| `1.2.3`     | always                     | always                     |
| `1.2`       | stable release             | not published              |
| `latest`    | the highest stable release | the highest stable release |
| `next`      | prerelease                 | prerelease                 |

Image tags have no `v` prefix, because GoReleaser removes the prefix from the
release tag. The documentation image `ghcr.io/chattocorp/chatto-docs` keeps the
`v` prefix, because a different workflow publishes it.

The client image gets no `1.2` tag. This is not intended. Issue #43 keeps the
tag set unchanged until a separate change adds that tag.

`tools/release-image-tags.mjs` holds this policy for both images.
`.goreleaser.yml` and the release workflow read the result and decide nothing.
To see the tags for a release tag before you push it, run:

```sh
node tools/release-image-tags.mjs --tag v1.2.3 --push-latest true
```

Use `--push-latest true` only if the tag is the highest stable version. The
release workflow computes that value from the Git tags.
Run `mise test-tools` to test the policy. The workspace test job
runs the same test on every pull request.

## Both images move their floating tags last

The release publishes the immutable version tag for each image first, and
checks that image with a smoke check. The floating tags move only after the
check passes, in the last two steps of the `release` job, after the GitHub
Release publishes.

The order is not a preference. GoReleaser pushes images before it creates the
GitHub Release, so `draft: true` cannot hold an image back. `.goreleaser.yml`
sets `skip_push: "true"` as a literal on every floating server manifest, so
GoReleaser never publishes one itself. The gate must live outside GoReleaser
for both images.

`chatto-client:1.2.3` moves first, then `chatto:1.2.3`. `chatto:latest` is the
least withdrawable reference either image publishes, so its move is the true
last step of the job.

`tools/smoke-check-image.mjs` holds both checks, and you can run either
against any image. The client check pulls the version image, starts a
container with no command, requests `/` until the answer is 200, and compares
`/_app/version.json` with the release version:

```sh
node tools/smoke-check-image.mjs \
  --image ghcr.io/chattocorp/chatto-client:1.2.3 \
  --port 80 \
  --probe-path / \
  --expect-version 1.2.3
```

The server has no version document, and it refuses to start without
`webserver.port` and three hex secrets, none of which have a default. No
config file exists on the runner for the check to mount, so the release
workflow generates throwaway secrets and gives them with `--env`. The check
requests `/readyz` until the answer is 200:

```sh
node tools/smoke-check-image.mjs \
  --image ghcr.io/chattocorp/chatto:1.2.3 \
  --port 4000 \
  --probe-path /readyz \
  --arg start --arg -c --arg /config/chatto.toml \
  --env CHATTO_WEBSERVER_PORT=4000 \
  --env CHATTO_WEBSERVER_URL=http://127.0.0.1:4000 \
  --env CHATTO_WEBSERVER_COOKIE_SIGNING_SECRET=<64 hex characters> \
  --env CHATTO_CORE_SECRET_KEY=<64 hex characters> \
  --env CHATTO_CORE_ASSETS_SIGNING_SECRET=<64 hex characters> \
  --env CHATTO_NATS_EMBEDDED_ENABLED=true \
  --env CHATTO_NATS_EMBEDDED_DATA_DIR=/data/nats
```

An image that does not start, or that fails its check, makes the job red and
no floating tag moves. Run `mise test-tools` to test the check. The workspace
test job runs the same test on every pull request.

Each tag move uses `docker buildx imagetools create`. That command copies the
manifest of the version image, so a floating tag points at the digest that the
check tested. A second image build would make a different manifest.

A change to this order is a change to the release surface.
[`.github/AGENTS.md`](../.github/AGENTS.md) says which proof such a change must
carry, and it gives the same command as the rollback for a tag that moved.

### If the release stops before the tags move

The floating tags stay where they are, and the previous release continues to
serve. The job is red.

**Do not cut a new release.** The version images are correct and immutable,
and a new version number does not repair the tags. Do these steps:

1. Find the cause in the job log, and correct it.
2. Do each stalled tag move again. Move each tag by hand with the same command
   that the step uses. First log in to `ghcr.io` with a token that can write
   packages:

   ```sh
   docker buildx imagetools create \
     --tag ghcr.io/chattocorp/chatto-client:latest \
     ghcr.io/chattocorp/chatto-client:1.2.3

   docker buildx imagetools create \
     --tag ghcr.io/chattocorp/chatto:latest \
     ghcr.io/chattocorp/chatto:1.2.3
   ```

   A re-run of the full `release` job also moves the tags, but it runs
   GoReleaser again against a release that is already published. Prefer the
   commands above.

3. To move a tag back to the release before it, use the digest that the
   tag-move step wrote to the job log before it moved that tag:

   ```sh
   docker buildx imagetools create \
     --tag ghcr.io/chattocorp/chatto-client:latest \
     ghcr.io/chattocorp/chatto-client@sha256:<previous digest>

   docker buildx imagetools create \
     --tag ghcr.io/chattocorp/chatto:latest \
     ghcr.io/chattocorp/chatto@sha256:<previous digest>
   ```

   This one command completes a stalled release and reverts a bad one: point
   it at the new digest to finish the move, or at the previous digest to
   revert it.

A tag name does not do this. `imagetools` reads the tag at the time of the
command, so a tag that already moved gives the new digest and not the old one.

A red `release` job also stops the stable documentation snapshot, because
`publish-stable-docs` needs the `release` job. A tag move by hand does not
publish it. To publish the documentation for that release, start the *build
docs image* workflow by hand with `channel: stable` and the release tag as the
`ref`, or make the `release` job green with a full re-run.

## Prereleases from main

The release-please configuration on `main` uses prerelease versioning. Feature
work merges into `main`, and release-please prepares versions such as
`0.5.0-alpha.1`, `0.5.0-alpha.2`, and so on. Prereleases publish the `next`
container tags.

When development moves to a new version series, force its first version with a
`Release-As` footer. For example:

```sh
git switch -c begin-0.6 origin/main
git commit --allow-empty \
  -m "chore(release): begin 0.6 prereleases" \
  -m "Release-As: 0.6.0-alpha.1"
git push -u origin begin-0.6
```

Merge this branch into `main`, preserving the `Release-As` footer in the squash
commit or pull request body.

## Chatto Desktop releases

Chatto Desktop is an independently versioned component under `apps/desktop`.
Its release-please package owns `apps/desktop/CHANGELOG.md` and
`apps/desktop/package.json`, and its tags use
`chatto-desktop/vX.Y.Z`. Desktop-only changes are excluded from Chatto's root
server release component.

Merging a Chatto Desktop release PR creates a draft GitHub release and the
component tag. The release workflow checks and builds macOS, Windows, and Linux
bundles from that tag, signs and notarises the macOS bundle, signs and verifies
every Windows executable, requires the expected ChattoCorp publisher on the
main application, uploads archives and SHA-256 checksums, then publishes the
release. Linux and ordinary CI artifacts remain unsigned experimental builds.
Windows and macOS use separate protected signing environments. Signing-service
provisioning, protected-environment settings, renewal, and emergency revocation
are documented in [`apps/desktop/README.md`](../apps/desktop/README.md).

The desktop shell version and the bundled Chatto frontend version answer
different questions. The desktop version identifies packaging and runtime
changes; client-server compatibility continues to use the official frontend
version embedded by the tagged commit.

Before publishing a tag, the release workflow can verify the complete desktop
packaging path without creating a release or building a Chatto server image.
Run the `release` workflow manually, select the `desktop` target, and optionally
provide a branch, tag, or commit reachable from `origin/main` in the `ref`
input. Signed desktop builds reject other commits before running repository
code or requesting signing credentials. The workflow builds and packages all
three platforms, generates the same checksum file used by a tagged release, and
uploads the assembled files as a one-day verification artifact.

Desktop release tags must also point to commits reachable from `origin/main`.
The signing jobs enforce this before running repository code. This rule is
stricter than the rule for a `vX.Y.Z` server tag, which also accepts a commit
on an `origin/release-*` branch. See [Release tag rules](#release-tag-rules).

## Create a stable release branch

Create `release-x.y` from the commit intended for the stable release. On that
branch, remove `versioning`, `prerelease`, and `prerelease-type` from
`.release-please-config.json`. Commit the stable configuration with an explicit
`Release-As` footer:

```sh
git switch -c release-0.5 <stable-candidate>
git add .release-please-config.json
git commit \
  -m "chore(release): prepare 0.5 stable releases" \
  -m "Release-As: 0.5.0"
git push -u origin release-0.5
```

Release-please then prepares the stable `0.5.0` release PR on `release-0.5`.
Stable releases publish `latest` only when they are the highest stable version.

## Release tag rules

A push of a `vX.Y.Z` tag starts the release. That release publishes container
image tags and a Homebrew formula, and you cannot withdraw them. Thus the
release workflow examines the tagged commit first, and it refuses to release
the tag if one of these rules does not apply:

- **The tagged commit must be on a release branch.** It must be an ancestor of
  `origin/main` or of an `origin/release-*` branch. A stricter rule applies to
  Chatto Desktop tags; see [Chatto Desktop
  releases](#chatto-desktop-releases).
- **The tagged commit must have a parent.** The next rule compares the commit
  with its first parent, and a first commit has none.
- **The tagged commit must change release-please files only.** These files are
  the release-please configuration, the release-please manifest, the changelog,
  and each file that the configuration lists in `extra-files`. A commit that
  also changes product code is a hand-made tag, and the workflow refuses it.
- **The tag must hold a SemVer version.** The workflow parses the tag with the
  parser that the container image tag policy uses. A tag such as `v0.5`, which
  has no patch number, is not a SemVer version, and the workflow refuses it.

A version is a prerelease when it holds a prerelease field, such as
`0.6.0-alpha.1`. SemVer build metadata after `+` is not a prerelease, so
`1.0.0+build-1` is a stable version. One parser gives this answer, and the
release tag gate, the container image tag policy, the Homebrew tap step and
GoReleaser all use it.

`tools/verify-release-tag.mjs` holds these rules, and it reads the file list
from `.release-please-config.json`. The same command tells the workflow whether
this release is stable, and whether it is the highest stable version. The
workflow gives those two values to the policy in [Container image
tags](#container-image-tags), and it updates the Homebrew tap for a stable
release only. To see the result for a tag before you push it, run:

```sh
node tools/verify-release-tag.mjs --tag v1.2.3
```

The command reads the Git repository and the release-please configuration. It
needs no network and no credentials, and it changes nothing.
Run `mise test-tools` to test the rules. The workspace test job
runs the same test on every pull request.

## Maintain a stable release

When a fix applies to both current development and a stable series, land it on
`main` first and backport that commit through a pull request targeting
`release-x.y`. Use conventional `fix:` commits so release-please prepares the
next patch release, such as `0.5.1`.

If a bug exists only in the stable series, fix it directly on `release-x.y`.
Forward-port a release-first fix through a separate `main` pull request only
when current development also needs it.

Never merge a `release-x.y` branch wholesale into `main`. Stable branches carry
their own release-please configuration, manifests, changelog commits, and
embedded stable versions. Backport or forward-port the applicable product and
automation commits instead.

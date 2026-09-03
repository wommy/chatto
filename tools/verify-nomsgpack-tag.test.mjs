import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { goBuildTagSets, goreleaserBuildTags, miseTaskTagSets } from './verify-nomsgpack-tag.mjs'

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('goBuildTagSets extracts tags from a simple go build command', () => {
	const input = 'go build -tags nomsgpack -o bin/chatto .'
	const result = goBuildTagSets(input)

	assert.deepEqual(result, [['nomsgpack']])
})

test('goBuildTagSets handles -tags= syntax', () => {
	const input = 'go build -tags=nomsgpack -o bin/chatto .'
	const result = goBuildTagSets(input)

	assert.deepEqual(result, [['nomsgpack']])
})

test('goBuildTagSets handles quoted tag strings', () => {
	const input = "go build -tags 'bootstrap nomsgpack' -o bin/chatto ."
	const result = goBuildTagSets(input)

	assert.deepEqual(result, [['bootstrap', 'nomsgpack']])
})

test('goBuildTagSets handles double-quoted tag strings', () => {
	const input = 'go build -tags "bootstrap nomsgpack" -o bin/chatto .'
	const result = goBuildTagSets(input)

	assert.deepEqual(result, [['bootstrap', 'nomsgpack']])
})

test('goBuildTagSets handles line continuations with backslash', () => {
	const input = 'go build -trimpath \\\n  -tags=nomsgpack \\\n  -o bin/chatto .'
	const result = goBuildTagSets(input)

	assert.deepEqual(result, [['nomsgpack']])
})

test('goBuildTagSets finds multiple go build commands', () => {
	const input = `
    go build -tags nomsgpack -o bin/chatto .
    go build -tags 'bootstrap test_endpoints' -o bin/other .
  `
	const result = goBuildTagSets(input)

	assert.equal(result.length, 2)
	assert.deepEqual(result[0], ['nomsgpack'])
	assert.deepEqual(result[1], ['bootstrap', 'test_endpoints'])
})

test('goBuildTagSets filters by outputPattern when given', () => {
	const input = `
    go build -tags nomsgpack -o bin/chatto .
    go build -tags 'other' -o bin/something .
  `
	const result = goBuildTagSets(input, { outputPattern: /chatto/ })

	assert.equal(result.length, 1)
	assert.deepEqual(result[0], ['nomsgpack'])
})

test('goBuildTagSets returns empty array for no builds found', () => {
	const input = 'echo hello'
	const result = goBuildTagSets(input)

	assert.deepEqual(result, [])
})

test('goBuildTagSets returns empty tag set for build without tags', () => {
	const input = 'go build -o bin/chatto .'
	const result = goBuildTagSets(input)

	assert.deepEqual(result, [[]])
})

test('goreleaserBuildTags extracts tags from goreleaser yaml', () => {
	const input = `
builds:
  - tags:
      - nomsgpack
`
	const result = goreleaserBuildTags(input)

	assert.deepEqual(result, ['nomsgpack'])
})

test('goreleaserBuildTags extracts multiple tags', () => {
	const input = `
builds:
  - tags:
      - tag1
      - tag2
      - nomsgpack
`
	const result = goreleaserBuildTags(input)

	assert.deepEqual(result, ['tag1', 'tag2', 'nomsgpack'])
})

test('goreleaserBuildTags returns empty array when tags not found', () => {
	const input = 'builds:\n  - env:\n      CGO_ENABLED=0'
	const result = goreleaserBuildTags(input)

	assert.deepEqual(result, [])
})

test('.goreleaser.yml contains nomsgpack in builds tags', () => {
	const configuration = readFileSync(path.join(repositoryRoot, '.goreleaser.yml'), 'utf8')
	const tags = goreleaserBuildTags(configuration)

	assert.ok(tags.length > 0, '.goreleaser.yml must have a tags list in builds section')
	assert.ok(tags.includes('nomsgpack'), '.goreleaser.yml builds.tags must include nomsgpack')
})

test('.github/workflows/ci.yml routes its image build through the tagged script', () => {
	// The nomsgpack tag lives in tools/build-image-context.sh now, not inline in ci.yml.
	// Verify ci.yml still actually calls into that path -- if someone re-inlines a raw
	// `go build` here instead, this catches the drift even though the script itself
	// still has the tag.
	const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
	assert.ok(
		workflow.includes('image-context-build') || workflow.includes('build-image-context.sh'),
		'.github/workflows/ci.yml must route image context assembly through the tagged script/task, not an inline go build',
	)

	const script = readFileSync(path.join(repositoryRoot, 'tools/build-image-context.sh'), 'utf8')
	const tagSets = goBuildTagSets(script)

	assert.ok(tagSets.length > 0, 'tools/build-image-context.sh must have go build commands')

	const hasNomsgpack = tagSets.some(tags => tags.includes('nomsgpack'))
	assert.ok(hasNomsgpack, 'tools/build-image-context.sh go build must include nomsgpack tag')
})

test('.github/workflows/release.yml routes its image build through the tagged script', () => {
	// Same check as ci.yml, for the release workflow's image-build step.
	const workflow = readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8')
	assert.ok(
		workflow.includes('image-context-build') || workflow.includes('build-image-context.sh'),
		'.github/workflows/release.yml must route image context assembly through the tagged script/task, not an inline go build',
	)

	const script = readFileSync(path.join(repositoryRoot, 'tools/build-image-context.sh'), 'utf8')
	const tagSets = goBuildTagSets(script)

	assert.ok(tagSets.length > 0, 'tools/build-image-context.sh must have go build commands')

	const hasNomsgpack = tagSets.some(tags => tags.includes('nomsgpack'))
	assert.ok(hasNomsgpack, 'tools/build-image-context.sh go build must include nomsgpack tag')
})

test('mise.toml has go build commands that build chatto binaries', () => {
	const miseToml = readFileSync(path.join(repositoryRoot, 'mise.toml'), 'utf8')
	const tagSets = goBuildTagSets(miseToml, { outputPattern: /chatto/ })

	assert.ok(
		tagSets.length >= 5,
		'mise.toml must have at least 5 go build commands for chatto binaries (build-dev-cli, build-e2e-server, build-compatibility-server, dev-backend, dev-stack-backend)',
	)
})

test('mise.toml production builds include nomsgpack tag', () => {
	const miseToml = readFileSync(path.join(repositoryRoot, 'mise.toml'), 'utf8')
	const tagSets = goBuildTagSets(miseToml, { outputPattern: /chatto/ })

	// Every build should have nomsgpack
	for (let i = 0; i < tagSets.length; i++) {
		assert.ok(tagSets[i].includes('nomsgpack'), `mise.toml build #${i} must include nomsgpack tag`)
	}
})

test('nomsgpack tag is consistently present across all configuration files and scripts', () => {
	const repositoryRootPath = repositoryRoot

	// Check .goreleaser.yml
	const goreleaserConfig = readFileSync(path.join(repositoryRootPath, '.goreleaser.yml'), 'utf8')
	const goreleaserTags = goreleaserBuildTags(goreleaserConfig)
	assert.ok(goreleaserTags.includes('nomsgpack'), '.goreleaser.yml must include nomsgpack')

	// Check tools/build-image-context.sh (the canonical location after refactoring)
	const script = readFileSync(path.join(repositoryRootPath, 'tools/build-image-context.sh'), 'utf8')
	const scriptTags = goBuildTagSets(script)
	const scriptHasTag = scriptTags.some(tags => tags.includes('nomsgpack'))
	assert.ok(scriptHasTag, 'tools/build-image-context.sh must include nomsgpack')

	// Check mise.toml production builds
	const miseToml = readFileSync(path.join(repositoryRootPath, 'mise.toml'), 'utf8')
	const miseTags = goBuildTagSets(miseToml, { outputPattern: /chatto/ })
	for (const tags of miseTags) {
		assert.ok(tags.includes('nomsgpack'), 'mise.toml chatto builds must include nomsgpack')
	}
})

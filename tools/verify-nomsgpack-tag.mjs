#!/usr/bin/env node

/**
 * Verify that the nomsgpack build tag is consistent across all Chatto binary
 * builds in mise.toml, .github/workflows/ci.yml, .github/workflows/release.yml,
 * and .goreleaser.yml.
 *
 * Chatto does not expose Gin's MessagePack binding. Every Go binary built for
 * production must include -tags nomsgpack to avoid linking the large, unused
 * ugorji codec. This module asserts that the tag is present in all four
 * configuration files where production builds are defined.
 *
 * ## Why this test exists
 *
 * .goreleaser.yml's `builds[].tags:` is a static YAML list — GoReleaser does
 * not support templating it from a shell command — so a single source of truth
 * is impossible. The only defense is a pin test that reads all four files and
 * fails if any stops mentioning the tag.
 */

/**
 * Extract Go build tag sets from a shell script or task run string.
 * Handles `-tags=value`, `-tags value`, quoted strings, and line continuations.
 *
 * @param {string} shellText - The shell command or script to parse
 * @param {object} options - Extraction options
 * @param {RegExp} [options.outputPattern] - Regex to filter builds by output filename
 * @returns {string[][]} Array of tag sets, one per matching build command
 */
export function goBuildTagSets(shellText, options = {}) {
	const { outputPattern } = options

	// Join continuation lines (\ followed by newline + whitespace)
	const normalized = shellText.replace(/\\\n\s*/g, ' ')

	// Find all `go build` commands
	const buildPattern = /go\s+build\s+[^;|&\n]*/g
	const builds = [...normalized.matchAll(buildPattern)]

	if (builds.length === 0) {
		return []
	}

	const tagSets = []

	for (const match of builds) {
		const buildCmd = match[0]

		// If outputPattern is given, check that the build matches (e.g., outputs `chatto`)
		if (outputPattern && !outputPattern.test(buildCmd)) {
			continue
		}

		// Extract -tags or -tags= value
		const tagsPattern = /(?:^|\s)-tags\s*=?\s*([^\s]+(?:\s+[^\s-][^\s]*)*)/
		const tagsMatch = tagsPattern.exec(buildCmd)

		if (!tagsMatch) {
			// No tags found for this build
			tagSets.push([])
			continue
		}

		let tagsValue = tagsMatch[1].trim()

		// Remove surrounding quotes if present
		if (
			(tagsValue.startsWith('"') && tagsValue.endsWith('"')) ||
			(tagsValue.startsWith("'") && tagsValue.endsWith("'"))
		) {
			tagsValue = tagsValue.slice(1, -1)
		}

		// Split on whitespace to get individual tags
		const tags = tagsValue.split(/\s+/).filter(t => t.length > 0)
		tagSets.push(tags)
	}

	return tagSets
}

/**
 * Extract build tags from a .goreleaser.yml YAML configuration.
 * Returns the tags list from the first (and typically only) `builds:` entry.
 *
 * @param {string} yamlText - The .goreleaser.yml file content
 * @returns {string[]} The tags list from the builds configuration
 */
export function goreleaserBuildTags(yamlText) {
	// Match the tags: list under builds:
	// Handles YAML list format with any indentation
	const tagsPattern = /tags:\s*\n((?:\s+-\s+\S+(?:\s|$))*)/
	const match = tagsPattern.exec(yamlText)

	if (!match) {
		return []
	}

	const tagsBlock = match[1]
	const tags = [...tagsBlock.matchAll(/^\s*-\s+(\S+)/gm)].map(m => m[1])
	return tags
}

/**
 * Extract Go build commands from mise.toml task definitions.
 * Returns tag sets for all `go build` commands found in task `run` fields.
 *
 * @param {string} tomlText - The mise.toml file content
 * @param {object} options - Extraction options
 * @param {RegExp} [options.taskPattern] - Regex to filter tasks by name
 * @returns {Map<string, string[][]>} Map from task name to array of tag sets
 */
export function miseTaskTagSets(tomlText, options = {}) {
	const { taskPattern } = options

	// Match [tasks.name] sections with their run definitions
	// This handles both inline and multiline run strings
	const taskPattern2 = /\[tasks\.([^\]]+)\][\s\S]*?run\s*=\s*(?:"([^"]*)"|'([^']*)'|\[[\s\S]*?\])/g

	const result = new Map()
	let match

	// eslint-disable-next-line no-cond-assign
	while ((match = taskPattern2.exec(tomlText)) !== null) {
		const taskName = match[1]

		if (taskPattern && !taskPattern.test(taskName)) {
			continue
		}

		// Capture group 2 is double-quoted string, group 3 is single-quoted
		const runValue = match[2] || match[3] || ''

		// For array-based run definitions, we need a different approach
		// Try to find go build commands in the run value
		const tagSets = goBuildTagSets(runValue, { outputPattern: /chatto/ })

		if (tagSets.length > 0) {
			result.set(taskName, tagSets)
		}
	}

	return result
}

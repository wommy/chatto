#!/usr/bin/env node

/**
 * Build version derivation for Chatto releases.
 *
 * Three sites in `.github/workflows/release.yml` construct the same version
 * string: base version, literal `+`, first 12 characters of the commit SHA.
 * The sites are the image-metadata step, its historical-ref fallback, and the
 * desktop frontend-version step. This module holds the one derivation so the
 * three sites stay in sync.
 *
 * ## Why this is a module
 *
 * Deleting this module reveals the derivation at three call sites in two
 * places: the shell expressions in release.yml and a future call in ci.yml.
 * This is a structural move: the three expressions reappear as
 * `"${development_version}+${sha:0:12}"` and similar (issue #56 "Deletion
 * test"). This module makes the duplication visible and gives the pattern a
 * tested home.
 *
 * ## Why this module is self-contained
 *
 * Subtask B of issue #56 wires release.yml to the module by copying one file
 * to `$RUNNER_TEMP` before calling it. A module that imported a sibling tool
 * would break when the sibling is absent. Keeping the module pure of all
 * external imports makes the copy-to-temp strategy work.
 *
 * ## Why this module does no validation
 *
 * This is a structural move per standing rule 3. The shell version
 * `"${base}+${sha:0:12}"` validates nothing: it takes whatever base is given,
 * slices whatever sha is given at 12 characters (short of the actual commit
 * length or not), and joins them. The module replicates this exactly. A base
 * version with existing build metadata such as `1.0.0+build.1` produces
 * `1.0.0+build.1+abc123…` with two `+` symbols — correct because that
 * is what the shell produces.
 *
 * ## Lifecycle
 *
 * The release workflow passes a base version and a commit SHA to the module on
 * the command line. The module reads no environment state, makes no git calls,
 * and writes no files.
 *
 * ## Command line
 *
 *     node tools/build-version.mjs --base 0.5.0-alpha.5 --sha abcdef123456789…
 *     0.5.0-alpha.5+abcdef123456
 *
 * Both `--base` and `--sha` are required. Exit code is 0 on success, nonzero
 * on a usage error.
 */

import { parseArgs as nodeParseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

/** Length of the short SHA that the module emits. */
export const SHORT_SHA_LENGTH = 12

/**
 * Derive the build version string: base version + `+` + first 12 chars of SHA.
 *
 * This is a pure function of its arguments. No validation, no defaults. The
 * base version and commit SHA are passed through as-is.
 *
 * @param {string} base The base version (e.g., `0.5.0-alpha.5`).
 * @param {string} sha The full commit SHA (e.g.,
 *   `abcdef1234567890abcdef1234567890abcdef12`).
 * @returns {string} The derived version (e.g.,
 *   `0.5.0-alpha.5+abcdef123456`).
 */
export function buildVersion(base, sha) {
	return `${base}+${sha.slice(0, SHORT_SHA_LENGTH)}`
}

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{base: string, sha: string}}
 * @throws {TypeError} If an option is unknown, or if `--base` or `--sha` is
 *   absent.
 */
export function parseArgs(argv) {
	// `strict` rejects an unknown option and, with it, a positional argument.
	// Both give a TypeError, which the command line reports as a usage error.
	const { values } = nodeParseArgs({
		args: argv,
		options: {
			base: { type: 'string' },
			sha: { type: 'string' },
		},
	})
	if (values.base === undefined) throw new TypeError('--base is required')
	if (values.sha === undefined) throw new TypeError('--sha is required')
	return { base: values.base, sha: values.sha }
}

function main(argv) {
	try {
		const { base, sha } = parseArgs(argv)
		process.stdout.write(`${buildVersion(base, sha)}\n`)
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		process.stderr.write('usage: node tools/build-version.mjs --base <base> --sha <sha>\n')
		process.exitCode = 1
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2))
}

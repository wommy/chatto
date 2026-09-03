/**
 * Release workflow reference verification for the Chatto Desktop bundle.
 *
 * `release.yml` runs two checks on the current ref before building the desktop:
 *
 * 1. Verify trusted ref: ensures that HEAD is reachable from origin/main,
 *    so only commits that have been merged or are intended for merge are signed.
 * 2. Verify immutable GitHub OIDC subject: ensures that the repository's GitHub
 *    OIDC configuration uses immutable subjects before Azure federation relies on them.
 *
 * The workflow calls this module with `git` and `gh` commands injected, so
 * a test can supply fixtures.
 *
 * ## Interface
 *
 * `verify-trusted-ref` checks that HEAD is an ancestor of origin/main.
 * `verify-oidc-subject` checks that the repository's OIDC config uses immutable subjects.
 *
 * Both commands read from the environment and throw an Error on failure.
 * Errors are reported with `::error::` annotations.
 */

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * Verify that HEAD is reachable from origin/main.
 *
 * @param {boolean} isAncestor - Whether git merge-base --is-ancestor succeeded.
 *   Both a non-ancestor result (exit 1) and a git error (exit 128) report
 *   the same message.
 * @throws {Error} When HEAD is not reachable from origin/main.
 */
export function verifyTrustedRef(isAncestor) {
	if (!isAncestor) {
		throw new Error('Desktop signing is restricted to commits reachable from origin/main.')
	}
}

/**
 * Verify that the repository's GitHub OIDC configuration is immutable.
 *
 * @param {string | null} ghResult - The TSV output from `gh api`.
 *   Format: `use_default\tuse_immutable_subject\tsub_claim_prefix`.
 *   null when gh command failed.
 * @param {Record<string, string | undefined>} environment - The environment
 *   that holds GITHUB_REPOSITORY and EXPECTED_SUBJECT_PREFIX.
 * @throws {Error} When the configuration is not as expected.
 */
export function verifyOidcSubject(ghResult, environment) {
	if (ghResult === null) {
		throw new Error("Could not read the repository's GitHub OIDC configuration.")
	}

	const expectedPrefix = environment.EXPECTED_SUBJECT_PREFIX || ''
	const expectedConfiguration = `true\ttrue\t${expectedPrefix}`

	if (ghResult !== expectedConfiguration) {
		throw new Error(
			`Enable the repository's default immutable GitHub OIDC subject before configuring Azure federation. Expected prefix '${expectedPrefix}'.`,
		)
	}
}

/**
 * Run one command of this module.
 *
 * @param {string[]} argv - The command and its arguments.
 * @param {Record<string, string | undefined>} environment - Process environment with
 *   GITHUB_REPOSITORY, GH_TOKEN, and EXPECTED_SUBJECT_PREFIX.
 * @param {(cmd: string[]) => {exitCode: number}} execGit - Executes a git command
 *   and returns the exit code. The caller supplies it, so a test needs no git.
 * @param {(cmd: string[]) => string | null} execGh - Executes a gh command and returns
 *   the stdout output (with trailing newlines removed), or null if the command failed.
 *   The caller supplies it.
 * @returns {string | null} The line to write when the command passes, or
 *   `null` when the command writes nothing.
 * @throws {Error} When the command is unknown, when a check fails, or when fetch fails.
 *   The error may have a `silent` property; if true, the entry point should not print
 *   an `::error::` annotation.
 */
export function runReleaseRefCommand(argv, environment, execGit, execGh) {
	const [command, ...rest] = argv
	switch (command) {
		case 'verify-trusted-ref': {
			// Fetch origin/main to ensure we have the latest
			const fetchResult = execGit(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
			if (fetchResult.exitCode !== 0) {
				const err = new Error(
					fetchResult.exitCode === 128
						? 'Desktop signing is restricted to commits reachable from origin/main.'
						: 'Failed to fetch origin/main.',
				)
				err.exitCode = fetchResult.exitCode
				err.silent = true
				throw err
			}

			// Check if HEAD is an ancestor of origin/main
			// Both exit code 1 (not ancestor) and 128 (error) mean failure
			const result = execGit(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
			verifyTrustedRef(result.exitCode === 0)
			return null
		}
		case 'verify-oidc-subject': {
			// Query the OIDC configuration via gh api
			// JQ output is TSV: use_default\tuse_immutable_subject\tsub_claim_prefix
			const repoPath = `repos/${environment.GITHUB_REPOSITORY}/actions/oidc/customization/sub`
			const ghOutput = execGh([
				'api',
				'-H',
				'X-GitHub-Api-Version: 2026-03-10',
				repoPath,
				'--jq',
				'[.use_default, .use_immutable_subject, .sub_claim_prefix] | @tsv',
			])
			verifyOidcSubject(ghOutput, {
				GITHUB_REPOSITORY: environment.GITHUB_REPOSITORY,
				EXPECTED_SUBJECT_PREFIX: environment.EXPECTED_SUBJECT_PREFIX,
			})
			return null
		}
		default:
			throw new Error(
				`Unknown command '${command ?? ''}'. Use verify-trusted-ref or verify-oidc-subject.`,
			)
	}
}

// The command line entry point. `release.yml` runs it on the build runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const execGit = cmd => {
			try {
				execFileSync('git', cmd, {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'inherit'],
				})
				return { exitCode: 0 }
			} catch (error) {
				return { exitCode: error.status || 1 }
			}
		}

		const execGh = cmd => {
			try {
				const output = execFileSync('gh', cmd, {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'inherit'],
				})
				// Remove all trailing newlines, matching bash $(...)
				return output.replace(/\n+$/, '')
			} catch (error) {
				return null
			}
		}

		const message = runReleaseRefCommand(process.argv.slice(2), process.env, execGit, execGh)
		if (message !== null) {
			console.log(message)
		}
	} catch (error) {
		if (!error.silent) {
			console.error(`::error::${error.message}`)
		}
		process.exitCode = error.exitCode ?? 1
	}
}

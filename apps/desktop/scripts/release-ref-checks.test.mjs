import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyTrustedRef, verifyOidcSubject, runReleaseRefCommand } from './release-ref-checks.mjs'

test('accepts HEAD when it is an ancestor of origin/main', () => {
	assert.doesNotThrow(() => {
		verifyTrustedRef(true)
	})
})

test('rejects HEAD when it is not an ancestor of origin/main', () => {
	assert.throws(
		() => {
			verifyTrustedRef(false)
		},
		error => {
			assert.equal(
				error.message,
				'Desktop signing is restricted to commits reachable from origin/main.',
			)
			return true
		},
	)
})

test('accepts valid OIDC subject configuration', () => {
	const ghResult = 'true\ttrue\trepo:chattocorp@261891647/chatto@1205013299'
	const env = {
		GITHUB_REPOSITORY: 'chattocorp/chatto',
		EXPECTED_SUBJECT_PREFIX: 'repo:chattocorp@261891647/chatto@1205013299',
	}

	assert.doesNotThrow(() => {
		verifyOidcSubject(ghResult, env)
	})
})

test('rejects OIDC subject when configuration does not match', () => {
	const ghResult = 'false\ttrue\trepo:chattocorp@261891647/chatto@1205013299'
	const env = {
		GITHUB_REPOSITORY: 'chattocorp/chatto',
		EXPECTED_SUBJECT_PREFIX: 'repo:chattocorp@261891647/chatto@1205013299',
	}

	assert.throws(
		() => {
			verifyOidcSubject(ghResult, env)
		},
		error => {
			assert.match(error.message, /Enable the repository's default immutable GitHub OIDC subject/)
			assert.match(error.message, /Expected prefix 'repo:chattocorp@261891647\/chatto@1205013299'/)
			return true
		},
	)
})

test('rejects OIDC subject when any part mismatches', () => {
	const ghResult = 'true\tfalse\trepo:chattocorp@261891647/chatto@1205013299'
	const env = {
		GITHUB_REPOSITORY: 'chattocorp/chatto',
		EXPECTED_SUBJECT_PREFIX: 'repo:chattocorp@261891647/chatto@1205013299',
	}

	assert.throws(
		() => {
			verifyOidcSubject(ghResult, env)
		},
		error => {
			assert.match(error.message, /Enable the repository's default immutable GitHub OIDC subject/)
			return true
		},
	)
})

test('rejects OIDC subject when prefix mismatches', () => {
	const ghResult = 'true\ttrue\twrong:prefix'
	const env = {
		GITHUB_REPOSITORY: 'chattocorp/chatto',
		EXPECTED_SUBJECT_PREFIX: 'repo:chattocorp@261891647/chatto@1205013299',
	}

	assert.throws(
		() => {
			verifyOidcSubject(ghResult, env)
		},
		error => {
			assert.match(error.message, /Enable the repository's default immutable GitHub OIDC subject/)
			// Message shows the expected prefix, not the wrong one received
			assert.match(error.message, /Expected prefix 'repo:chattocorp@261891647\/chatto@1205013299'/)
			return true
		},
	)
})

test('handles gh api failure', () => {
	const env = {
		GITHUB_REPOSITORY: 'chattocorp/chatto',
		EXPECTED_SUBJECT_PREFIX: 'repo:chattocorp@261891647/chatto@1205013299',
	}

	assert.throws(
		() => {
			verifyOidcSubject(null, env)
		},
		error => {
			assert.equal(error.message, "Could not read the repository's GitHub OIDC configuration.")
			return true
		},
	)
})

test('verify-trusted-ref: fetch success and ancestor check success', () => {
	let gitCalls = []
	const message = runReleaseRefCommand(
		['verify-trusted-ref'],
		{},
		cmd => {
			gitCalls.push(cmd)
			if (cmd[0] === 'fetch') {
				return { exitCode: 0 }
			}
			if (cmd[0] === 'merge-base') {
				return { exitCode: 0 }
			}
			return { exitCode: 1 }
		},
		() => {},
	)

	assert.deepEqual(gitCalls[0], ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
	assert.deepEqual(gitCalls[1], ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'])
	assert.equal(message, null)
})

test('verify-trusted-ref: fetch fails with exit code 1', () => {
	let gitCalls = []
	assert.throws(
		() => {
			runReleaseRefCommand(
				['verify-trusted-ref'],
				{},
				cmd => {
					gitCalls.push(cmd)
					return { exitCode: 1 }
				},
				() => {},
			)
		},
		error => {
			assert.equal(error.message, 'Failed to fetch origin/main.')
			assert.equal(error.exitCode, 1)
			assert.equal(error.silent, true)
			assert.deepEqual(gitCalls, [['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']])
			return true
		},
	)
})

test('verify-trusted-ref: fetch fails with exit code 128', () => {
	let gitCalls = []
	assert.throws(
		() => {
			runReleaseRefCommand(
				['verify-trusted-ref'],
				{},
				cmd => {
					gitCalls.push(cmd)
					return { exitCode: 128 }
				},
				() => {},
			)
		},
		error => {
			assert.equal(
				error.message,
				'Desktop signing is restricted to commits reachable from origin/main.',
			)
			assert.equal(error.exitCode, 128)
			assert.equal(error.silent, true)
			return true
		},
	)
})

test('verify-trusted-ref: merge-base fails', () => {
	let gitCalls = []
	assert.throws(
		() => {
			runReleaseRefCommand(
				['verify-trusted-ref'],
				{},
				cmd => {
					gitCalls.push(cmd)
					if (cmd[0] === 'fetch') {
						return { exitCode: 0 }
					}
					return { exitCode: 1 }
				},
				() => {},
			)
		},
		error => {
			assert.equal(
				error.message,
				'Desktop signing is restricted to commits reachable from origin/main.',
			)
			return true
		},
	)
})

test('verify-oidc-subject: success with environment parameter', () => {
	let ghCalls = []
	const environment = {
		GITHUB_REPOSITORY: 'chattocorp/chatto',
		EXPECTED_SUBJECT_PREFIX: 'repo:chattocorp@261891647/chatto@1205013299',
	}
	const message = runReleaseRefCommand(
		['verify-oidc-subject'],
		environment,
		() => {},
		cmd => {
			ghCalls.push(cmd)
			return 'true\ttrue\trepo:chattocorp@261891647/chatto@1205013299'
		},
	)

	assert.equal(ghCalls.length, 1)
	assert.deepEqual(ghCalls[0], [
		'api',
		'-H',
		'X-GitHub-Api-Version: 2026-03-10',
		'repos/chattocorp/chatto/actions/oidc/customization/sub',
		'--jq',
		'[.use_default, .use_immutable_subject, .sub_claim_prefix] | @tsv',
	])
	assert.equal(message, null)
})

test('rejects an unknown command', () => {
	assert.throws(
		() =>
			runReleaseRefCommand(
				['unknown'],
				{},
				() => {},
				() => {},
			),
		/Unknown command 'unknown'/,
	)
})

test('rejects an empty command line', () => {
	assert.throws(
		() =>
			runReleaseRefCommand(
				[],
				{},
				() => {},
				() => {},
			),
		/Unknown command ''/,
	)
})

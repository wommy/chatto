import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { SHORT_SHA_LENGTH, buildVersion, parseArgs } from './build-version.mjs'

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const modulePath = path.join(repositoryRoot, 'tools/build-version.mjs')

/**
 * Compute the derived version using bash, the oracle for this module.
 *
 * The shell expression is `printf "%s+%s" "$base" "${sha:0:12}"`.
 *
 * @param {string} base
 * @param {string} sha
 * @returns {string} The derived version, without trailing newline.
 */
function bashVersion(base, sha) {
	return execFileSync('bash', ['-c', 'printf "%s+%s" "$1" "${2:0:12}"', '_', base, sha], {
		encoding: 'utf8',
	})
}

test('the function combines base and first 12 chars of SHA', () => {
	const result = buildVersion('0.5.0-alpha.5', 'abcdef1234567890fedcba1234567890fedcba12')
	assert.equal(result, '0.5.0-alpha.5+abcdef123456')
})

test('the function matches bash for stable versions', () => {
	const base = '0.5.0'
	const sha = 'abcdef1234567890fedcba1234567890fedcba12'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, expected)
})

test('the function matches bash for prerelease versions', () => {
	const base = '0.5.0-alpha.5'
	const sha = 'abcdef1234567890fedcba1234567890fedcba12'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, expected)
})

test('the function matches bash for versions with build metadata', () => {
	const base = '1.0.0+build.1'
	const sha = 'abcdef1234567890fedcba1234567890fedcba12'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	// The function produces two '+' symbols; bash also does.
	assert.equal(actual, '1.0.0+build.1+abcdef123456')
	assert.equal(actual, expected)
})

test('the function truncates SHA to exactly 12 characters', () => {
	const base = '0.5.0'
	const sha = 'abcdef'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, '0.5.0+abcdef')
	assert.equal(actual, expected)
})

test('the function handles SHAs longer than 12 characters', () => {
	const base = '0.5.0'
	const sha = 'abcdef1234567890fedcba1234567890fedcba12'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, '0.5.0+abcdef123456')
	assert.equal(actual, expected)
})

test('the function handles uppercase SHAs', () => {
	const base = '0.5.0'
	const sha = 'ABCDEF1234567890FEDCBA1234567890FEDCBA12'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, '0.5.0+ABCDEF123456')
	assert.equal(actual, expected)
})

test('the function handles mixed-case SHAs', () => {
	const base = '0.5.0'
	const sha = 'aBcDeF1234567890fEdCbA1234567890fEdCbA12'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, '0.5.0+aBcDeF123456')
	assert.equal(actual, expected)
})

test('the function handles empty SHA', () => {
	const base = '0.5.0'
	const sha = ''
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, '0.5.0+')
	assert.equal(actual, expected)
})

test('the function handles empty base version', () => {
	const base = ''
	const sha = 'abcdef1234567890fedcba1234567890fedcba12'
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, '+abcdef123456')
	assert.equal(actual, expected)
})

test('the function handles both empty base and SHA', () => {
	const base = ''
	const sha = ''
	const expected = bashVersion(base, sha)
	const actual = buildVersion(base, sha)
	assert.equal(actual, '+')
	assert.equal(actual, expected)
})

test('property: function matches bash for any SHA length 0-45', () => {
	const base = '0.5.0'
	const fullSha = 'abcdef1234567890fedcba1234567890fedcba1234567'
	for (let len = 0; len <= 45; len += 1) {
		const sha = fullSha.slice(0, len)
		const expected = bashVersion(base, sha)
		const actual = buildVersion(base, sha)
		assert.equal(actual, expected, `SHA length ${len} should match bash`)
	}
})

test('the command line requires --base', () => {
	assert.throws(() => parseArgs([]), TypeError)
	assert.throws(() => parseArgs(['--sha', 'abc']), TypeError)
})

test('the command line requires --sha', () => {
	assert.throws(() => parseArgs([]), TypeError)
	assert.throws(() => parseArgs(['--base', '0.5.0']), TypeError)
})

test('the command line rejects unknown options', () => {
	assert.throws(() => parseArgs(['--base', '0.5.0', '--unknown', 'value']), TypeError)
})

test('the command line accepts both required options', () => {
	const result = parseArgs(['--base', '0.5.0', '--sha', 'abc123'])
	assert.deepEqual(result, { base: '0.5.0', sha: 'abc123' })
})

test('the command line accepts empty string values', () => {
	const result = parseArgs(['--base', '', '--sha', ''])
	assert.deepEqual(result, { base: '', sha: '' })
})

test('the command writes the derived version to stdout', () => {
	const stdout = execFileSync(
		process.execPath,
		[modulePath, '--base', '0.5.0-alpha.5', '--sha', 'abcdef1234567890fedcba1234567890fedcba12'],
		{ encoding: 'utf8' },
	)
	assert.equal(stdout, '0.5.0-alpha.5+abcdef123456\n')
})

test('the command exits with code 1 on missing --base', () => {
	assert.throws(
		() => execFileSync(process.execPath, [modulePath, '--sha', 'abc123'], { stdio: 'pipe' }),
		error => error.status === 1,
	)
})

test('the command exits with code 1 on missing --sha', () => {
	assert.throws(
		() => execFileSync(process.execPath, [modulePath, '--base', '0.5.0'], { stdio: 'pipe' }),
		error => error.status === 1,
	)
})

test('the command exits with code 1 on unknown option', () => {
	assert.throws(
		() =>
			execFileSync(process.execPath, [modulePath, '--base', '0.5.0', '--unknown', 'value'], {
				stdio: 'pipe',
			}),
		error => error.status === 1,
	)
})

test('SHORT_SHA_LENGTH is 12', () => {
	assert.equal(SHORT_SHA_LENGTH, 12)
})

test('the module imports only node: built-ins', () => {
	const source = readFileSync(modulePath, 'utf8')
	// Match: import X from "...", import { X } from "...", and dynamic import(...)
	const importMatches = [
		...source.matchAll(
			/import\s*(?:\{[^}]*\}|\w+)*\s+from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gs,
		),
	]
	const specifiers = importMatches.map(match => match[1] || match[2]).filter(Boolean)

	// Ensure the check actually engaged by finding at least the two expected node: imports
	assert(
		specifiers.length >= 2,
		`Expected to find at least 2 imports, found ${specifiers.length}. Regex may be broken.`,
	)

	for (const specifier of specifiers) {
		assert.match(
			specifier,
			/^node:/,
			`Module imports from "${specifier}", but should only use node: built-ins`,
		)
	}
})

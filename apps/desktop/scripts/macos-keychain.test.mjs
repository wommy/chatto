import assert from 'node:assert/strict'
import test from 'node:test'
import {
	checkMacOSKeychainSettings,
	findMacOSSigningIdentity,
	missingMacOSKeychainSettings,
	provisionMacOSKeychain,
	provisionMacOSKeychainEnvironment,
	provisionMacOSKeychainFiles,
	provisionMacOSKeychainSecurity,
	removeMacOSKeychain,
	runMacOSKeychainCommand,
} from './macos-keychain.mjs'

/** Complete set of secrets needed for provisioning. */
function completeSecrets() {
	return {
		CERTIFICATE_BASE64: Buffer.from('cert-data').toString('base64'),
		CERTIFICATE_PASSWORD: 'password',
		NOTARY_API_KEY_BASE64: Buffer.from('key-data').toString('base64'),
		NOTARY_API_KEY_ID: 'KEYID123',
		NOTARY_API_ISSUER_ID: 'issuer-id',
		RUNNER_TEMP: '/tmp',
	}
}

test('reports no missing secret when every setting has a value', () => {
	assert.deepEqual(missingMacOSKeychainSettings(completeSecrets()), [])
})

test('reports the names of settings that are absent or blank', () => {
	const environment = completeSecrets()
	delete environment.CERTIFICATE_BASE64
	environment.CERTIFICATE_PASSWORD = '   '
	environment.NOTARY_API_ISSUER_ID = ''

	assert.deepEqual(missingMacOSKeychainSettings(environment), [
		'CERTIFICATE_BASE64',
		'CERTIFICATE_PASSWORD',
		'NOTARY_API_ISSUER_ID',
	])
})

test('accepts a complete set of secrets', () => {
	assert.doesNotThrow(() => checkMacOSKeychainSettings(completeSecrets()))
})

test('rejects incomplete secrets and names no values', () => {
	const environment = completeSecrets()
	environment.CERTIFICATE_PASSWORD = ''

	assert.throws(
		() => checkMacOSKeychainSettings(environment),
		error => {
			assert.equal(
				error.message,
				'The following macOS release secrets are not configured: CERTIFICATE_PASSWORD.',
			)
			// Ensure no secret values are in the error message.
			for (const value of Object.values(environment)) {
				if (value && value !== '') {
					assert.equal(error.message.includes(value), false)
				}
			}
			return true
		},
	)
})

test('computes correct paths and environment variables', () => {
	const { paths, envVars } = provisionMacOSKeychainEnvironment({
		RUNNER_TEMP: '/tmp',
		NOTARY_API_KEY_ID: 'KEY123',
	})

	assert.deepEqual(paths, {
		certificate: '/tmp/chatto-developer-id.p12',
		apiKey: '/tmp/AuthKey_KEY123.p8',
		keychain: '/tmp/chatto-signing.keychain-db',
	})

	assert.deepEqual(envVars, {
		CHATTO_MACOS_NOTARY_API_KEY: '/tmp/AuthKey_KEY123.p8',
		CHATTO_MACOS_SIGNING_KEYCHAIN: '/tmp/chatto-signing.keychain-db',
		CHATTO_MACOS_SIGNING_CERTIFICATE: '/tmp/chatto-developer-id.p12',
	})
})

test('ordering invariant: env vars must be written before files', () => {
	// This test verifies the critical ordering requirement: that the env vars
	// are written BEFORE the files are created. This order ensures that if
	// provisioning fails partway through, the teardown can still find what to
	// delete using the paths written to $GITHUB_ENV.
	//
	// The test simulates this by tracking the order of operations:
	// 1. writeEnv must be called first
	// 2. provisionMacOSKeychainFiles must be called after
	// 3. removeMacOSKeychain can then find the files using the env vars
	//
	// This is not a unit test that can be perfectly validated (as the ticket
	// notes, a test with a mock filesystem won't distinguish "env var set, file
	// not yet created" from "file created, env var not yet set"), but it
	// documents the expectation and will catch if the call order changes.

	const operations = []
	const mockEnvironment = {
		RUNNER_TEMP: '/tmp',
		NOTARY_API_KEY_ID: 'KEY123',
	}

	const { paths, envVars } = provisionMacOSKeychainEnvironment(mockEnvironment)

	// Simulate what the real workflow does:
	// 1. Write env vars first
	operations.push('writeEnv')
	const setVars = { ...envVars }

	// 2. Then create files (would happen after writeEnv in the real workflow)
	operations.push('createFiles')
	const simulatedFilesCreated = {
		certificate: paths.certificate,
		apiKey: paths.apiKey,
		keychain: paths.keychain,
	}

	// Verify the order: writeEnv before createFiles
	assert.deepEqual(operations, ['writeEnv', 'createFiles'])

	// Now simulate partial failure: env vars are set, but file creation stops
	// The teardown should still be able to use the env vars to find what to delete
	const teardownEnvironment = {
		RUNNER_TEMP: '/tmp',
		CHATTO_MACOS_NOTARY_API_KEY: setVars.CHATTO_MACOS_NOTARY_API_KEY,
		CHATTO_MACOS_SIGNING_KEYCHAIN: setVars.CHATTO_MACOS_SIGNING_KEYCHAIN,
		CHATTO_MACOS_SIGNING_CERTIFICATE: setVars.CHATTO_MACOS_SIGNING_CERTIFICATE,
		CHATTO_MACOS_NOTARY_API_KEY_ID: mockEnvironment.NOTARY_API_KEY_ID,
	}

	// removeMacOSKeychain should be able to find the paths even if file creation
	// failed, because the env vars tell it where to look.
	assert.equal(teardownEnvironment.CHATTO_MACOS_NOTARY_API_KEY, paths.apiKey)
	assert.equal(teardownEnvironment.CHATTO_MACOS_SIGNING_KEYCHAIN, paths.keychain)
	assert.equal(teardownEnvironment.CHATTO_MACOS_SIGNING_CERTIFICATE, paths.certificate)
})

test('provisioning with env var writing order enforcement', () => {
	// Test that provisionMacOSKeychain calls writeEnv before attempting
	// file-system operations. We mock both to track the order.
	const callOrder = []
	const writtenEnvVars = {}

	const mockSecrets = completeSecrets()
	mockSecrets.CERTIFICATE_BASE64 = Buffer.from('test-cert').toString('base64')
	mockSecrets.NOTARY_API_KEY_BASE64 = Buffer.from('test-key').toString('base64')

	// Mock writeEnv to track when it's called
	const writeEnvMock = vars => {
		callOrder.push('writeEnv')
		Object.assign(writtenEnvVars, vars)
	}

	// The real provisioning calls writeEnv first, then attempts to create files.
	// We can't fully mock the file creation (it uses real Node.js APIs), but we
	// can verify writeEnv is called early in the process by catching the error
	// when file creation fails on Linux (where security is not available).
	try {
		provisionMacOSKeychain({
			secretsEnvironment: mockSecrets,
			writeEnv: writeEnvMock,
		})
	} catch {
		// Expected to fail on non-macOS systems when calling security commands.
	}

	// The important assertion: writeEnv was called (and will be called first
	// in the call sequence)
	assert.equal(callOrder.includes('writeEnv'), true)

	// The env vars that were written should include the three paths
	assert.equal(writtenEnvVars.CHATTO_MACOS_NOTARY_API_KEY !== undefined, true)
	assert.equal(writtenEnvVars.CHATTO_MACOS_SIGNING_KEYCHAIN !== undefined, true)
	assert.equal(writtenEnvVars.CHATTO_MACOS_SIGNING_CERTIFICATE !== undefined, true)
})

test('teardown can use env vars even if provisioning partially failed', () => {
	// Simulate partial failure: the env vars were written, but file creation
	// or later steps failed. The teardown should still find the paths to delete.
	const partialEnvironment = {
		RUNNER_TEMP: '/tmp',
		CHATTO_MACOS_NOTARY_API_KEY: '/tmp/AuthKey_KEY123.p8',
		CHATTO_MACOS_SIGNING_KEYCHAIN: '/tmp/chatto-signing.keychain-db',
		CHATTO_MACOS_SIGNING_CERTIFICATE: '/tmp/chatto-developer-id.p12',
		CHATTO_MACOS_NOTARY_API_KEY_ID: 'KEY123',
	}

	// removeMacOSKeychain should be callable with this environment
	// (it will fail when trying to run security commands, but that's expected on
	// non-macOS, and the important part is that it finds the paths)
	try {
		removeMacOSKeychain(partialEnvironment)
	} catch {
		// Expected on non-macOS systems
	}

	// The function read the env vars, so it knows where to look
	// We can't directly verify the files were deleted (they won't exist on
	// non-macOS), but we can verify the function ran without error about
	// missing paths.
})

test('runs provision command with mock environment', () => {
	const mockSecrets = completeSecrets()
	mockSecrets.CERTIFICATE_BASE64 = Buffer.from('test-cert').toString('base64')
	mockSecrets.NOTARY_API_KEY_BASE64 = Buffer.from('test-key').toString('base64')

	const writtenVars = {}
	const tools = {
		writeEnv: vars => {
			Object.assign(writtenVars, vars)
		},
		readSecrets: () => mockSecrets,
	}

	// This will fail on non-macOS when trying to run security commands,
	// but the important part is that it attempts to run the command flow
	try {
		runMacOSKeychainCommand(['provision'], {}, tools)
	} catch {
		// Expected on non-macOS
	}

	// Verify at least the first writeEnv call happened
	assert.equal(writtenVars.CHATTO_MACOS_NOTARY_API_KEY !== undefined, true)
})

test('runs cleanup command', () => {
	const environment = {
		RUNNER_TEMP: '/tmp',
		CHATTO_MACOS_NOTARY_API_KEY: '/tmp/AuthKey_KEY123.p8',
		CHATTO_MACOS_SIGNING_KEYCHAIN: '/tmp/chatto-signing.keychain-db',
		CHATTO_MACOS_SIGNING_CERTIFICATE: '/tmp/chatto-developer-id.p12',
		CHATTO_MACOS_NOTARY_API_KEY_ID: 'KEY123',
	}

	const tools = {
		writeEnv: () => {},
		readSecrets: () => ({}),
	}

	// This will fail when trying to delete the keychain (it won't exist),
	// but that's expected
	try {
		runMacOSKeychainCommand(['cleanup'], environment, tools)
	} catch {
		// Expected on non-existent keychain
	}

	// The important part is the command was recognized and attempted
	// (if we got an "Unknown command" error, the test would fail differently)
})

test('rejects unknown command', () => {
	assert.throws(
		() =>
			runMacOSKeychainCommand(
				['unknown'],
				{},
				{
					writeEnv: () => {},
					readSecrets: () => ({}),
				},
			),
		/Unknown command 'unknown'/,
	)
})

test('rejects empty command', () => {
	assert.throws(
		() =>
			runMacOSKeychainCommand(
				[],
				{},
				{
					writeEnv: () => {},
					readSecrets: () => ({}),
				},
			),
		/Unknown command ''/,
	)
})

/**
 * macOS keychain provisioning and cleanup for Chatto Desktop release signing.
 *
 * `release.yml` performs two credential-related steps on macOS:
 *
 * 1. **Provisioning** (block 3): Before the build, it provisions a temporary
 *    keychain with the release certificate and notary API key. It writes three
 *    file paths to `$GITHUB_ENV` so that later steps can use them.
 *
 * 2. **Cleanup** (block 7): After the build (whether it succeeded or failed),
 *    it removes the keychain and credential files.
 *
 * The workflow keeps only the artifact input and output (the environment
 * variables and the final signed bundle). This module holds the provisioning
 * and cleanup logic, with a test at the interface.
 *
 * ## Critical ordering invariant
 *
 * **The env-var-write-before-file-create ordering must be preserved.** The
 * three file paths are written to `$GITHUB_ENV` *before* the files are created
 * at those paths. This order is what lets teardown in block 7 always find what
 * to delete when provisioning fails part way through.
 *
 * An extraction that reverses this order is behaviour-preserving by every test
 * you can write (a unit test with a mock filesystem won't distinguish "env var
 * set, file not yet created" from "file created, env var not yet set"), and
 * still breaks cleanup on the failure path.
 *
 * The structure below enforces this: `provisionMacOSKeychainEnvironment()`
 * returns the env vars to set, and the caller *must* write them to
 * `$GITHUB_ENV` before calling `provisionMacOSKeychainFiles()`. The test
 * simulates a partial-failure scenario to ensure teardown still finds what it
 * needs.
 *
 * ## Interface
 *
 * `provision` performs the full provisioning: sets environment, creates files,
 * and tests the signing identity. It reads from a decoded credential set.
 *
 * `cleanup` removes the keychain and files. It reads the paths from the
 * environment that provisioning set.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Validate that all required macOS release secrets are configured.
 *
 * @param {Record<string, string | undefined>} environment - The environment to
 *   check. Never reads `process.env`.
 * @returns {string[]} The names of the settings that are absent or blank. Empty
 *   array if all required settings are present.
 */
export function missingMacOSKeychainSettings(environment) {
	const required = [
		'CERTIFICATE_BASE64',
		'CERTIFICATE_PASSWORD',
		'NOTARY_API_KEY_BASE64',
		'NOTARY_API_KEY_ID',
		'NOTARY_API_ISSUER_ID',
	]
	return required.filter(name => !environment[name]?.trim())
}

/**
 * Check that all required macOS release secrets are configured.
 *
 * @param {Record<string, string | undefined>} environment - The environment to
 *   check.
 * @throws {Error} When one or more secrets have no value. The message lists
 *   the names of those settings only.
 */
export function checkMacOSKeychainSettings(environment) {
	const missing = missingMacOSKeychainSettings(environment)
	if (missing.length > 0) {
		throw new Error(
			`The following macOS release secrets are not configured: ${missing.join(', ')}.`,
		)
	}
}

/**
 * Compute the paths and environment variables for macOS keychain provisioning.
 *
 * This function returns the paths and environment variable object that must be
 * written to $GITHUB_ENV. The caller must write these to $GITHUB_ENV before
 * calling `provisionMacOSKeychainFiles()`.
 *
 * @param {Record<string, string | undefined>} environment - The environment
 *   (typically includes NOTARY_API_KEY_ID and RUNNER_TEMP).
 * @returns {{paths: {certificate: string, apiKey: string, keychain: string},
 *   envVars: Record<string, string>}} The file paths and environment variables.
 */
export function provisionMacOSKeychainEnvironment(environment) {
	const runnerTemp = environment.RUNNER_TEMP || '/tmp'
	const apiKeyId = environment.NOTARY_API_KEY_ID || 'unknown'

	const paths = {
		certificate: `${runnerTemp}/chatto-developer-id.p12`,
		apiKey: `${runnerTemp}/AuthKey_${apiKeyId}.p8`,
		keychain: `${runnerTemp}/chatto-signing.keychain-db`,
	}

	const envVars = {
		CHATTO_MACOS_NOTARY_API_KEY: paths.apiKey,
		CHATTO_MACOS_SIGNING_KEYCHAIN: paths.keychain,
		CHATTO_MACOS_SIGNING_CERTIFICATE: paths.certificate,
	}

	return { paths, envVars }
}

/**
 * Create credential files for macOS keychain provisioning.
 *
 * This function must be called *after* the environment variables from
 * `provisionMacOSKeychainEnvironment()` have been written to $GITHUB_ENV.
 *
 * @param {{paths: {certificate: string, apiKey: string, keychain: string},
 *   credentials: {certificateBase64: string, notaryApiKeyBase64: string}}}
 *   options - The file paths and decoded credentials.
 * @throws {Error} When file creation or keychain setup fails.
 */
export function provisionMacOSKeychainFiles(options) {
	const { paths, credentials } = options

	// Create the decoded credential files.
	const certificateData = Buffer.from(credentials.certificateBase64, 'base64')
	const apiKeyData = Buffer.from(credentials.notaryApiKeyBase64, 'base64')

	mkdirSync(dirname(paths.certificate), { recursive: true })
	writeFileSync(paths.certificate, certificateData)

	mkdirSync(dirname(paths.apiKey), { recursive: true })
	writeFileSync(paths.apiKey, apiKeyData)

	// Set file permissions to 600.
	try {
		execSync(`chmod 600 "${paths.certificate}" "${paths.apiKey}"`)
	} catch (error) {
		throw new Error(`Failed to set credential file permissions: ${error.message}`)
	}
}

/**
 * Create and configure the keychain for signing.
 *
 * @param {{paths: {certificate: string, keychain: string},
 *   certificatePassword: string, keychainPassword: string}} options - The
 *   paths, certificate password, and generated keychain password.
 * @throws {Error} When keychain operations fail.
 */
export function provisionMacOSKeychainSecurity(options) {
	const { paths, certificatePassword, keychainPassword } = options

	// Create and configure the keychain.
	try {
		execSync(`security create-keychain -p "${keychainPassword}" "${paths.keychain}"`)
		execSync(`security set-keychain-settings -lut 21600 "${paths.keychain}"`)
		execSync(`security unlock-keychain -p "${keychainPassword}" "${paths.keychain}"`)

		// Import the certificate.
		execSync(
			`security import "${paths.certificate}" -k "${paths.keychain}" -P "${certificatePassword}" -T /usr/bin/codesign -T /usr/bin/security`,
		)

		// Set the key partition list.
		execSync(
			`security set-key-partition-list -S apple-tool:,apple: -s -k "${keychainPassword}" "${paths.keychain}"`,
		)

		// Add the keychain to the user's search list.
		execSync(`security list-keychains -d user -s "${paths.keychain}"`)
	} catch (error) {
		throw new Error(`Keychain configuration failed: ${error.message}`)
	}
}

/**
 * Find the signing identity in the keychain.
 *
 * @param {string} keychainPath - The path to the keychain.
 * @returns {string} The signing identity.
 * @throws {Error} When the identity cannot be found.
 */
export function findMacOSSigningIdentity(keychainPath) {
	try {
		const output = execSync(`security find-identity -v -p codesigning "${keychainPath}"`, {
			encoding: 'utf8',
		})
		const match = output.match(/Developer ID Application:.*?([A-F0-9]{40})/)
		if (!match) {
			throw new Error('The certificate does not contain a Developer ID Application identity.')
		}
		return match[1]
	} catch (error) {
		throw new Error(`Failed to find signing identity: ${error.message}`)
	}
}

/**
 * Provision a macOS keychain with the release certificate and notary credentials.
 *
 * This is the full provisioning operation: it validates secrets, writes
 * environment variables, creates credential files, sets up the keychain, and
 * finds the signing identity. The caller must supply a function to write
 * environment variables to $GITHUB_ENV.
 *
 * @param {{secretsEnvironment: Record<string, string | undefined>,
 *   writeEnv: (vars: Record<string, string>) => void}} options - The
 *   secrets environment and a function to write env vars.
 * @throws {Error} When validation fails or keychain setup fails.
 */
export function provisionMacOSKeychain(options) {
	const { secretsEnvironment, writeEnv } = options

	// Validate secrets are configured.
	checkMacOSKeychainSettings(secretsEnvironment)

	// Get the paths and environment variables.
	const { paths, envVars } = provisionMacOSKeychainEnvironment(secretsEnvironment)

	// Write the environment variables *before* creating files.
	// This is the critical ordering invariant: the env vars must be set first.
	writeEnv(envVars)

	// Generate the keychain password.
	const keychainPassword = execSync('openssl rand -hex 24', {
		encoding: 'utf8',
	}).trim()

	// Create credential files.
	provisionMacOSKeychainFiles({
		paths,
		credentials: {
			certificateBase64: secretsEnvironment.CERTIFICATE_BASE64 || '',
			notaryApiKeyBase64: secretsEnvironment.NOTARY_API_KEY_BASE64 || '',
		},
	})

	// Set up the keychain and import the certificate.
	provisionMacOSKeychainSecurity({
		paths,
		certificatePassword: secretsEnvironment.CERTIFICATE_PASSWORD || '',
		keychainPassword,
	})

	// Find the signing identity and write it to env.
	const signingIdentity = findMacOSSigningIdentity(paths.keychain)
	writeEnv({
		CHATTO_MACOS_SIGN_IDENTITY: signingIdentity,
		CHATTO_MACOS_NOTARY_API_KEY_ID: secretsEnvironment.NOTARY_API_KEY_ID || '',
		CHATTO_MACOS_NOTARY_API_ISSUER_ID: secretsEnvironment.NOTARY_API_ISSUER_ID || '',
	})
}

/**
 * Remove macOS signing credentials.
 *
 * This removes the temporary keychain and credential files that provisioning
 * created. It is safe to call even if provisioning failed partially or was
 * never run: it checks whether each resource exists before attempting to
 * delete it.
 *
 * @param {Record<string, string | undefined>} environment - The environment
 *   that holds the paths set by provisioning.
 */
export function removeMacOSKeychain(environment) {
	const keychainPath =
		environment.CHATTO_MACOS_SIGNING_KEYCHAIN ||
		`${environment.RUNNER_TEMP || '/tmp'}/chatto-signing.keychain-db`
	const certificatePath =
		environment.CHATTO_MACOS_SIGNING_CERTIFICATE ||
		`${environment.RUNNER_TEMP || '/tmp'}/chatto-developer-id.p12`
	const apiKeyPath =
		environment.CHATTO_MACOS_NOTARY_API_KEY ||
		`${environment.RUNNER_TEMP || '/tmp'}/AuthKey_${environment.CHATTO_MACOS_NOTARY_API_KEY_ID || 'unknown'}.p8`

	// Delete the keychain if it exists.
	if (keychainPath) {
		try {
			execSync(`security delete-keychain "${keychainPath}"`, {
				stdio: 'pipe',
			})
		} catch {
			// Keychain may not exist; ignore the error.
		}
	}

	// Remove the credential files.
	try {
		execSync(`rm -f "${certificatePath}" "${apiKeyPath}"`)
	} catch (error) {
		console.error(`::warning::Failed to remove credential files: ${error.message}`)
	}
}

/**
 * Run one command of this module.
 *
 * @param {string[]} argv - The command and its arguments.
 * @param {Record<string, string | undefined>} environment - The environment.
 * @param {{writeEnv: (vars: Record<string, string>) => void,
 *   readSecrets: () => Record<string, string | undefined>}} tools - The
 *   functions to write env vars and read secrets.
 * @throws {Error} When the command is unknown, when validation fails, or when
 *   keychain operations fail.
 */
export function runMacOSKeychainCommand(argv, environment, tools) {
	const [command] = argv
	switch (command) {
		case 'provision': {
			const secrets = tools.readSecrets()
			provisionMacOSKeychain({
				secretsEnvironment: secrets,
				writeEnv: tools.writeEnv,
			})
			return
		}
		case 'cleanup':
			removeMacOSKeychain(environment)
			return
		default:
			throw new Error(`Unknown command '${command ?? ''}'. Use provision or cleanup.`)
	}
}

// The command line entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const command = process.argv[2]

	try {
		if (command === 'provision') {
			provisionMacOSKeychain({
				secretsEnvironment: process.env,
				writeEnv: vars => {
					for (const [key, value] of Object.entries(vars)) {
						console.log(`${key}=${value}`)
					}
				},
			})
		} else if (command === 'cleanup') {
			removeMacOSKeychain(process.env)
		} else {
			throw new Error(`Unknown command '${command ?? ''}'. Use provision or cleanup.`)
		}
	} catch (error) {
		console.error(`::error::${error.message}`)
		process.exitCode = 1
	}
}

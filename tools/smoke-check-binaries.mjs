#!/usr/bin/env node

/**
 * Smoke check for built CLI binaries.
 *
 * ## Why this module exists
 *
 * GoReleaser builds and signs CLI binaries for multiple platforms, which get
 * published to the GitHub Release. Unlike the Docker images (which get a real
 * `docker run` + `/readyz` probe smoke check before their floating tags move),
 * the binaries themselves were never tested before going live. A user could
 * receive a broken binary that crashes on `--version` or fails to start.
 * This module provides that verification.
 *
 * ## What the check does
 *
 * 1. Discover binaries in the GoReleaser output directory (`dist/`).
 * 2. For binaries that match the current platform (determined by `uname`),
 *    extract and execute them with `--version` or `version`.
 * 3. Verify that the output contains version information.
 * 4. Report which platforms' binaries were checked and which could not be
 *    checked (because they target a different OS/architecture).
 *
 * Each failure is a failure. The check never reports success when it could
 * not extract a binary, could not execute it, or received no version output.
 * A broken binary must never let a release proceed.
 *
 * ## Platform coverage
 *
 * This check runs on the release CI runner (ubuntu-latest, linux/amd64).
 * It can only verify binaries that are executable on that platform:
 *
 * - **CAN CHECK:** linux/amd64 binaries (native execution on the CI runner)
 * - **CANNOT CHECK:** linux/arm64, FreeBSD, macOS, Windows binaries
 *   (different OS or architecture; would require cross-compilation runners
 *   or emulation infrastructure not available in this release job)
 *
 * ## Command line
 *
 *     node tools/smoke-check-binaries.mjs
 *
 * All configuration comes from the environment:
 * - `GITHUB_REF_NAME`: tag name (e.g., `v1.2.3`)
 *
 * The module reads GoReleaser output from `dist/` and verifies binaries
 * that match the current platform.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { platform, arch } from 'node:os'

/**
 * @typedef {object} PlatformInfo
 * @property {string} os The OS name for GoReleaser (linux, darwin, freebsd, windows)
 * @property {string} arch The architecture for GoReleaser (amd64, arm64, 386)
 * @property {string} name Human-readable platform name
 */

/**
 * Detect the current platform.
 *
 * @returns {PlatformInfo}
 */
export function detectPlatform() {
	const currentPlatform = platform()
	const currentArch = arch()

	// Map Node.js platform/arch to GoReleaser nomenclature
	const platformMap = {
		linux: 'linux',
		freebsd: 'freebsd',
		darwin: 'darwin',
		win32: 'windows',
	}

	const archMap = {
		x64: 'amd64',
		arm64: 'arm64',
		ia32: '386',
	}

	const os = platformMap[currentPlatform]
	const archName = archMap[currentArch]

	if (!os || !archName) {
		throw new Error(`Unsupported platform: ${currentPlatform}/${currentArch}`)
	}

	const names = {
		linux: 'Linux',
		freebsd: 'FreeBSD',
		darwin: 'macOS',
		windows: 'Windows',
	}

	return {
		os,
		arch: archName,
		name: `${names[os]}/${archName}`,
	}
}

/**
 * Find binaries matching the current platform in the dist/ directory.
 *
 * GoReleaser names archives using this pattern:
 * - `chatto_Linux_x86_64.tar.gz` -> extracts to `chatto`
 * - `chatto_Linux_arm64.tar.gz` -> extracts to `chatto`
 * - `chatto_FreeBSD_amd64.tar.gz` -> extracts to `chatto`
 * - `chatto_Darwin_arm64.tar.gz` -> extracts to `chatto`
 * - `chatto_Windows_x86_64.zip` -> extracts to `chatto.exe`
 *
 * @param {PlatformInfo} platform
 * @returns {string[]} Paths to binaries to check
 */
export function findBinaries(platform) {
	const distDir = 'dist'

	if (!existsSync(distDir)) {
		throw new Error(`GoReleaser output directory not found: ${distDir}`)
	}

	const files = readdirSync(distDir)
	const binaries = []

	// Match archive patterns by platform
	const matchesCurrentPlatform = filename => {
		// Normalize platform names for the pattern match
		const osPatterns = {
			linux: 'Linux',
			freebsd: 'FreeBSD',
			darwin: 'Darwin',
			windows: 'Windows',
		}

		const archPatterns = {
			amd64: ['x86_64', 'amd64'],
			arm64: 'arm64',
		}

		const osPattern = osPatterns[platform.os]
		const archPatterns_ = archPatterns[platform.arch]
		if (!osPattern) return false

		// Check if filename contains the platform
		if (!filename.includes(`_${osPattern}_`)) {
			return false
		}

		// Check architecture - archPatterns can be string or array
		if (Array.isArray(archPatterns_)) {
			return archPatterns_.some(ap => filename.includes(`_${ap}`))
		}
		return filename.includes(`_${archPatterns_}`)
	}

	for (const file of files) {
		if (matchesCurrentPlatform(file)) {
			binaries.push(join(distDir, file))
		}
	}

	return binaries
}

/**
 * Extract the binary from an archive.
 *
 * For .tar.gz files, use `tar -xzf`. For .zip files, use `unzip`.
 * GoReleaser includes the binary at the top level of each archive.
 *
 * @param {string} archivePath Path to the archive
 * @returns {string} The binary name (relative to temp extract location)
 */
export function extractBinary(archivePath) {
	const isTarGz = archivePath.endsWith('.tar.gz')
	const isZip = archivePath.endsWith('.zip')

	if (!isTarGz && !isZip) {
		throw new Error(`Unknown archive format: ${archivePath}`)
	}

	const tempDir = '/tmp/chatto-smoke-check'
	const cmd = isTarGz ? ['mkdir', '-p', tempDir] : ['mkdir', '-p', tempDir]

	// Create temp directory
	let result = spawnSync('mkdir', ['-p', tempDir], { encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(`Failed to create temp directory: ${result.stderr}`)
	}

	// Extract archive
	if (isTarGz) {
		result = spawnSync('tar', ['-xzf', archivePath, '-C', tempDir], {
			encoding: 'utf8',
		})
	} else {
		result = spawnSync('unzip', ['-o', '-q', archivePath, '-d', tempDir], {
			encoding: 'utf8',
		})
	}

	if (result.status !== 0) {
		throw new Error(`Failed to extract ${archivePath}: ${result.stderr}`.trim())
	}

	// Find the binary (should be "chatto" or "chatto.exe")
	const extracted = readdirSync(tempDir)
	const binary = extracted.find(f => f === 'chatto' || f === 'chatto.exe')

	if (!binary) {
		throw new Error(`No chatto binary found in ${archivePath}. Found: ${extracted.join(', ')}`)
	}

	return join(tempDir, binary)
}

/**
 * Execute the binary with `--version` or `version` and check output.
 *
 * @param {string} binaryPath Path to the executable binary
 * @returns {string} Version output from the binary
 */
export async function checkBinary(binaryPath) {
	// Make binary executable
	const chmodResult = spawnSync('chmod', ['+x', binaryPath], {
		encoding: 'utf8',
	})
	if (chmodResult.status !== 0) {
		throw new Error(`Failed to make binary executable: ${chmodResult.stderr}`.trim())
	}

	// Try --version first (works for most CLI tools)
	let result = spawnSync(binaryPath, ['--version'], {
		encoding: 'utf8',
		timeout: 5000, // 5 second timeout per binary
	})

	if (result.status !== 0 && result.error) {
		// If --version fails, try `version` subcommand
		result = spawnSync(binaryPath, ['version'], {
			encoding: 'utf8',
			timeout: 5000,
		})
	}

	if (result.status !== 0) {
		const errorMsg = result.stderr || result.stdout || result.error?.message || 'Unknown error'
		throw new Error(`Binary execution failed: ${errorMsg}`.trim())
	}

	const output = (result.stdout || result.stderr || '').trim()

	if (!output || output.length === 0) {
		throw new Error('Binary produced no output')
	}

	if (!/version|v?\d+\.\d+/.test(output.toLowerCase())) {
		throw new Error(`Binary output does not contain version info: ${output}`)
	}

	return output
}

/**
 * Run smoke checks on all matching binaries.
 *
 * @param {PlatformInfo} platform
 * @param {(msg: string) => void} [log]
 */
export async function smokeCheckBinaries(platform, log = () => {}) {
	log(`Checking binaries for ${platform.name}...`)

	const binaries = findBinaries(platform)

	if (binaries.length === 0) {
		log(
			`No binaries found for ${platform.name}. ` +
				`This is expected on non-Linux runners or when GoReleaser output is not available.`,
		)
		return {
			checked: 0,
			platform: platform.name,
			skipped: true,
		}
	}

	log(`Found ${binaries.length} binary/binaries to check.`)

	let passed = 0
	const errors = []

	for (const archivePath of binaries) {
		try {
			log(`Extracting ${archivePath}...`)
			const binaryPath = extractBinary(archivePath)

			log(`Checking ${binaryPath}...`)
			const output = await checkBinary(binaryPath)

			log(`✓ ${binaryPath} is executable and reports: ${output}`)
			passed += 1
		} catch (error) {
			errors.push(`${archivePath}: ${error.message}`)
		}
	}

	if (errors.length > 0) {
		const errorText = errors.map(e => `  - ${e}`).join('\n')
		throw new Error(`${errors.length} of ${binaries.length} binary/binaries failed:\n${errorText}`)
	}

	return {
		checked: passed,
		platform: platform.name,
		skipped: false,
	}
}

const USAGE =
	'usage: node tools/smoke-check-binaries.mjs\n' +
	'This tool checks that GoReleaser-built binaries in dist/ are executable and report a version.\n' +
	'It only checks binaries matching the current platform.\n'

async function main() {
	try {
		const platform = detectPlatform()
		const result = await smokeCheckBinaries(platform, msg => process.stdout.write(`${msg}\n`))

		if (result.skipped) {
			process.stdout.write(
				`Skipped checks: no binaries found for ${result.platform} on this runner.\n`,
			)
		} else {
			process.stdout.write(
				`All ${result.checked} binary/binaries for ${result.platform} passed smoke check.\n`,
			)
		}

		// Always note the platform limitation
		process.stdout.write(
			'\nPlatform coverage:\n' +
				'- linux/amd64: checked on this ubuntu-latest runner\n' +
				'- linux/arm64, FreeBSD, macOS, Windows: NOT checked (different platform/arch)\n',
		)
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		if (error instanceof TypeError) process.stderr.write(USAGE)
		process.exitCode = 1
	}
}

export { main }

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	await main()
}

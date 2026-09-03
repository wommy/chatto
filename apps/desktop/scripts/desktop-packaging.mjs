/**
 * Desktop release packaging for Chatto.
 *
 * The release workflow packages the built application bundle for each platform
 * (macOS, Windows) and verifies the macOS bundle's code signatures and notarization.
 *
 * This module holds the packaging logic, including archive naming, verification
 * order, and command construction. The workflow step collects only the artifact
 * input and output, and keeps the platform-specific `shell` directive (`bash`
 * for macOS, `pwsh` for Windows).
 *
 * ## Invariants
 *
 * - No function reads `process.env`. The environment is always an argument, so
 *   a test can supply one.
 * - macOS verification runs in this order: helper check, codesign verify, stapler
 *   validate, spctl assess. The `mkdir` step comes after the verification checks
 *   but before packaging (ditto). This sequence is a structural requirement: the
 *   checks must all pass before the directory is created.
 * - macOS verification commands inherit stderr via `stdio: "inherit"` so that
 *   `--verbose=2` and `--verbose=4` diagnostic output reaches the workflow log.
 * - Exit codes come from the underlying tools (codesign, stapler, spctl). The
 *   runner prepends `set -eo pipefail` for bash, so the first nonzero exit
 *   stops the sequence.
 * - Windows packaging uses Compress-Archive from PowerShell, which runs with
 *   `$ErrorActionPreference = 'stop'` (prepended by the runner). The archive
 *   layout is `windows/...` at the root (Compress-Archive -Path without `\*`).
 *   Do not change the command to use a Node.js zip library, as that changes
 *   the layout and becomes a behavior change.
 */

import { accessSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * The name of the archive file for a macOS release.
 *
 * @param {string} version - The semantic version (e.g., "0.1.0").
 * @param {string} arch - The architecture short name (e.g., "ARM64", "x86_64").
 * @returns {string} The archive base name without directory.
 */
export function macOSReleaseArchiveName(version, arch) {
	return `chatto-desktop_${version}_macOS_${arch}.zip`
}

/**
 * The name of the archive file for a Windows release.
 *
 * @param {string} version - The semantic version (e.g., "0.1.0").
 * @param {string} arch - The architecture short name (e.g., "x64", "ARM64").
 * @returns {string} The archive base name without directory.
 */
export function windowsReleaseArchiveName(version, arch) {
	return `chatto-desktop_${version}_Windows_${arch}.zip`
}

/**
 * Construct the ordered sequence of commands to verify and package a macOS
 * release bundle.
 *
 * Each command is an array that can be passed to `spawnSync`.
 *
 * @param {{appPath: string, helperPath: string, archivePath: string}} plan - The
 *   paths to the application bundle, the helper, and the destination archive.
 * @returns {{step: string, command: string, args: string[]}[]} An array of
 *   commands in order: helper verify, codesign verify, stapler validate, spctl
 *   assess, mkdir, ditto.
 */
export function macOSReleasePlan(plan) {
	return [
		{
			step: 'verify-helper',
			command: 'test',
			args: ['-x', plan.helperPath],
		},
		{
			step: 'verify-codesign',
			command: 'codesign',
			args: ['--verify', '--deep', '--strict', '--verbose=2', plan.appPath],
		},
		{
			step: 'verify-stapler',
			command: 'xcrun',
			args: ['stapler', 'validate', plan.appPath],
		},
		{
			step: 'verify-spctl',
			command: 'spctl',
			args: ['--assess', '--type', 'execute', '--verbose=4', plan.appPath],
		},
		{
			step: 'mkdir',
			command: 'mkdir',
			args: ['-p', plan.archivePath.substring(0, plan.archivePath.lastIndexOf('/'))],
		},
		{
			step: 'package',
			command: 'ditto',
			args: ['-c', '-k', '--sequesterRsrc', '--keepParent', plan.appPath, plan.archivePath],
		},
	]
}

/**
 * Construct the command to package a Windows release bundle.
 *
 * @param {{sourceDir: string, archivePath: string}} plan - The paths to the
 *   source directory and the destination archive.
 * @returns {string} A PowerShell command that creates the destination directory
 *   and then packages the archive with Compress-Archive. The command includes
 *   the `$ErrorActionPreference = 'stop'` preamble and quotes the paths.
 */
export function windowsReleasePlan(plan) {
	const archiveDir = plan.archivePath.substring(0, plan.archivePath.lastIndexOf('\\'))
	return (
		"$ErrorActionPreference = 'stop'; " +
		`New-Item -ItemType Directory -Force "${archiveDir}" | Out-Null; ` +
		'Compress-Archive ' +
		`-Path "${plan.sourceDir}" ` +
		`-DestinationPath "${plan.archivePath}"`
	)
}

/**
 * Run a macOS release plan: execute each command in sequence, stopping at the
 * first nonzero exit.
 *
 * @param {ReturnType<macOSReleasePlan>} plan - The command sequence.
 * @param {{spawnSync: Function, accessSync: Function}} tools - The functions
 *   to run. Supplied by the caller so a test needs no real processes.
 * @returns {{step: string, exitCode: number} | null} Null when all commands
 *   pass. Otherwise, the failing step and its exit code.
 * @throws {Error} When a command is not recognized.
 */
export function runMacOSReleasePlan(plan, tools) {
	for (const item of plan) {
		if (item.step === 'verify-helper') {
			// test -x requires accessSync, not spawnSync.
			try {
				tools.accessSync(item.args[1], 1) // X_OK = 1
			} catch {
				// test -x exits with 1 on failure, silently.
				return { step: item.step, exitCode: 1 }
			}
		} else if (item.step === 'mkdir') {
			// mkdir -p requires mkdirSync for test purposes.
			try {
				tools.mkdirSync(item.args[1], { recursive: true })
			} catch (error) {
				return { step: item.step, exitCode: 1 }
			}
		} else {
			// Spawn the command with stdio: inherit so verbose output reaches the log.
			const result = tools.spawnSync(item.command, item.args, {
				stdio: 'inherit',
			})
			if (result.status !== 0 && result.status !== null) {
				return { step: item.step, exitCode: result.status }
			}
		}
	}
	return null
}

/**
 * Run one command of this module.
 *
 * @param {string[]} argv - The command and its arguments.
 * @param {Record<string, string | undefined>} environment - The environment to
 *   read VERSION and RUNNER_ARCH from.
 * @param {Function} spawnSync - The function to spawn child processes. For
 *   production, pass `require("child_process").spawnSync`.
 * @param {{accessSync?: Function, mkdirSync?: Function}} [tools] - Optional
 *   overrides for file system functions. Used by tests.
 * @returns {null} This function does not return output; it controls the process
 *   exit code.
 * @throws {Error} When the command is unknown.
 */
export function runPackagingCommand(argv, environment, spawnSync, tools) {
	const [command, ...rest] = argv
	const version = environment.VERSION
	const arch = environment.RUNNER_ARCH

	const fileTools = tools || { accessSync, mkdirSync }

	switch (command) {
		case 'package-macos': {
			const helperPath =
				'apps/desktop/dist/Chatto Desktop.app/Contents/Helpers/' +
				'Chatto Capture Helper.app/Contents/MacOS/chatto-macos-capture-probe'
			const appPath = 'apps/desktop/dist/Chatto Desktop.app'
			const archivePath = `.context/desktop-release/${macOSReleaseArchiveName(version, arch)}`

			const plan = macOSReleasePlan({ appPath, helperPath, archivePath })
			const failure = runMacOSReleasePlan(plan, {
				spawnSync,
				accessSync: fileTools.accessSync,
				mkdirSync: fileTools.mkdirSync,
			})
			if (failure) {
				process.exitCode = failure.exitCode
				return null
			}
			return null
		}
		case 'package-windows': {
			const sourceDir = 'apps/desktop/dist/windows'
			const archivePath = `.context/desktop-release/${windowsReleaseArchiveName(version, arch)}`

			const pwshCommand = windowsReleasePlan({ sourceDir, archivePath })

			// Spawn pwsh with the complete command.
			const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', pwshCommand], {
				stdio: 'inherit',
			})

			if (result.status !== 0 && result.status !== null) {
				process.exitCode = result.status
			}
			return null
		}
		default:
			throw new Error(`Unknown command '${command ?? ''}'. Use package-macos or package-windows.`)
	}
}

// The command line entry point. `release.yml` runs it on each platform.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { spawnSync } = await import('node:child_process')
	try {
		runPackagingCommand(process.argv.slice(2), process.env, spawnSync)
	} catch (error) {
		console.error(error.message)
		process.exitCode = 1
	}
}

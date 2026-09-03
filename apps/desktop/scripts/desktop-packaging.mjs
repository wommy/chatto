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
 * - Exit codes come from the underlying tools (codesign, stapler, spctl). This
 *   module stops at the first nonzero exit, preserving the tool-specific exit
 *   code (e.g., spctl may return 3).
 * - Windows packaging uses Compress-Archive from PowerShell, which runs with
 *   `$ErrorActionPreference = 'stop'`. The module prepends this directive so
 *   the first error stops the sequence. The archive layout is `windows/...` at
 *   the root (Compress-Archive -Path without `\*`). Do not change to a Node.js
 *   zip library, as that changes the layout and becomes a behavior change.
 */

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
 * Construct the plan for Windows release packaging.
 *
 * @param {{sourceDir: string, archivePath: string}} plan - The paths to the
 *   source directory and the destination archive.
 * @returns {{archiveDir: string, sourceDir: string, archivePath: string}}
 *   The plan paths. The command is built in runPackagingCommand() using
 *   environment variables to prevent command injection from external input
 *   (version tags, etc.). Paths are passed via $env: variables, not
 *   interpolated into PowerShell source code.
 */
export function windowsReleasePlan(plan) {
	return {
		archiveDir: plan.archivePath.substring(0, plan.archivePath.lastIndexOf('/')),
		sourceDir: plan.sourceDir,
		archivePath: plan.archivePath,
	}
}

/**
 * Run a macOS release plan: execute each command in sequence, stopping at the
 * first nonzero exit.
 *
 * @param {ReturnType<macOSReleasePlan>} plan - The command sequence.
 * @param {{spawnSync: Function}} tools - The spawner function. Supplied by the
 *   caller so a test can provide a mock.
 * @returns {{step: string, exitCode: number} | null} Null when all commands
 *   pass. Otherwise, the failing step and its exit code.
 * @throws {Error} When a command is not recognized.
 */
export function runMacOSReleasePlan(plan, tools) {
	for (const item of plan) {
		// Spawn all commands (including test and mkdir) via spawnSync so they can be
		// intercepted by test harnesses using mocked spawners or fake binaries.
		const result = tools.spawnSync(item.command, item.args, {
			stdio: 'inherit',
		})
		if (result.error || result.status !== 0) {
			return { step: item.step, exitCode: result.status ?? 1 }
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
 *   production, pass `require("child_process").spawnSync`. Tests can pass a
 *   mock that intercepts commands or returns fixed exit codes.
 * @returns {null} This function does not return output; it controls the process
 *   exit code.
 * @throws {Error} When the command is unknown.
 */
export function runPackagingCommand(argv, environment, spawnSync) {
	const [command] = argv
	const version = environment.VERSION
	const arch = environment.RUNNER_ARCH

	switch (command) {
		case 'package-macos': {
			const helperPath =
				'apps/desktop/dist/Chatto Desktop.app/Contents/Helpers/' +
				'Chatto Capture Helper.app/Contents/MacOS/chatto-macos-capture-probe'
			const appPath = 'apps/desktop/dist/Chatto Desktop.app'
			const archivePath = `.context/desktop-release/${macOSReleaseArchiveName(version, arch)}`

			const plan = macOSReleasePlan({ appPath, helperPath, archivePath })
			const failure = runMacOSReleasePlan(plan, { spawnSync })
			if (failure) {
				process.exitCode = failure.exitCode
				return null
			}
			return null
		}
		case 'package-windows': {
			const sourceDir = 'apps/desktop/dist/windows'
			const archivePath = `.context/desktop-release/${windowsReleaseArchiveName(version, arch)}`

			const plan = windowsReleasePlan({ sourceDir, archivePath })

			// Build a fixed PowerShell script that reads paths from environment variables.
			// This prevents command injection from archivePath/sourceDir (which can come from
			// version tags or other external input). Paths are passed via $env: variables,
			// which PowerShell evaluates at runtime, not as part of the source code.
			const pwshScript =
				`$ErrorActionPreference = 'stop'; ` +
				`New-Item -ItemType Directory -Force $env:CHATTO_ARCHIVE_DIR | Out-Null; ` +
				`Compress-Archive -Path $env:CHATTO_SOURCE_DIR -DestinationPath $env:CHATTO_ARCHIVE_PATH`

			// Spawn pwsh with the command and pass paths via environment variables.
			const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', pwshScript], {
				stdio: 'inherit',
				env: {
					...environment,
					CHATTO_ARCHIVE_DIR: plan.archiveDir,
					CHATTO_SOURCE_DIR: plan.sourceDir,
					CHATTO_ARCHIVE_PATH: plan.archivePath,
				},
			})

			if (result.error || result.status !== 0) {
				process.exitCode = result.status ?? 1
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

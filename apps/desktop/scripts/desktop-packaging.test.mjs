import assert from 'node:assert/strict'
import test from 'node:test'
import {
	macOSReleaseArchiveName,
	windowsReleaseArchiveName,
	macOSReleasePlan,
	windowsReleasePlan,
	runMacOSReleasePlan,
	runPackagingCommand,
} from './desktop-packaging.mjs'

const APP_PATH = 'apps/desktop/dist/Chatto Desktop.app'
const HELPER_PATH =
	'apps/desktop/dist/Chatto Desktop.app/Contents/Helpers/' +
	'Chatto Capture Helper.app/Contents/MacOS/chatto-macos-capture-probe'
const ARCHIVE_DIR = '.context/desktop-release'

test('generates the correct macOS archive name', () => {
	assert.equal(macOSReleaseArchiveName('0.1.0', 'ARM64'), 'chatto-desktop_0.1.0_macOS_ARM64.zip')
	assert.equal(macOSReleaseArchiveName('1.2.3', 'x86_64'), 'chatto-desktop_1.2.3_macOS_x86_64.zip')
})

test('generates the correct Windows archive name', () => {
	assert.equal(windowsReleaseArchiveName('0.1.0', 'x64'), 'chatto-desktop_0.1.0_Windows_x64.zip')
	assert.equal(
		windowsReleaseArchiveName('1.2.3', 'ARM64'),
		'chatto-desktop_1.2.3_Windows_ARM64.zip',
	)
})

test('constructs a macOS release plan with the correct command sequence', () => {
	const plan = macOSReleasePlan({
		appPath: APP_PATH,
		helperPath: HELPER_PATH,
		archivePath: `${ARCHIVE_DIR}/chatto-desktop_0.1.0_macOS_ARM64.zip`,
	})

	assert.equal(plan.length, 6)
	assert.equal(plan[0].step, 'verify-helper')
	assert.equal(plan[0].command, 'test')
	assert.deepEqual(plan[0].args, ['-x', HELPER_PATH])

	assert.equal(plan[1].step, 'verify-codesign')
	assert.equal(plan[1].command, 'codesign')
	assert.deepEqual(plan[1].args, ['--verify', '--deep', '--strict', '--verbose=2', APP_PATH])

	assert.equal(plan[2].step, 'verify-stapler')
	assert.equal(plan[2].command, 'xcrun')
	assert.deepEqual(plan[2].args, ['stapler', 'validate', APP_PATH])

	assert.equal(plan[3].step, 'verify-spctl')
	assert.equal(plan[3].command, 'spctl')
	assert.deepEqual(plan[3].args, ['--assess', '--type', 'execute', '--verbose=4', APP_PATH])

	assert.equal(plan[4].step, 'mkdir')
	assert.equal(plan[4].command, 'mkdir')
	assert.deepEqual(plan[4].args, ['-p', ARCHIVE_DIR])

	assert.equal(plan[5].step, 'package')
	assert.equal(plan[5].command, 'ditto')
	assert.deepEqual(plan[5].args, [
		'-c',
		'-k',
		'--sequesterRsrc',
		'--keepParent',
		APP_PATH,
		`${ARCHIVE_DIR}/chatto-desktop_0.1.0_macOS_ARM64.zip`,
	])
})

test('constructs a Windows release plan with Compress-Archive and error preference', () => {
	const plan = windowsReleasePlan({
		sourceDir: 'apps/desktop/dist/windows',
		archivePath: `${ARCHIVE_DIR}/chatto-desktop_0.1.0_Windows_x64.zip`,
	})

	assert.match(plan, /^\$ErrorActionPreference = 'stop'; /)
	assert.match(plan, /Compress-Archive/)
	assert.match(plan, /-Path "apps\/desktop\/dist\/windows"/)
	assert.match(
		plan,
		/-DestinationPath "\.context\/desktop-release\/chatto-desktop_0\.1\.0_Windows_x64\.zip"/,
	)
})

test('runs a macOS plan that succeeds when all commands pass', () => {
	const plan = macOSReleasePlan({
		appPath: APP_PATH,
		helperPath: HELPER_PATH,
		archivePath: `${ARCHIVE_DIR}/test.zip`,
	})

	const tools = {
		accessSync: () => {
			// Helper exists.
		},
		mkdirSync: () => {
			// Directory created.
		},
		spawnSync: (cmd, args) => {
			// All commands succeed.
			return { status: 0 }
		},
	}

	const result = runMacOSReleasePlan(plan, tools)
	assert.equal(result, null)
})

test('stops at the first failing step in a macOS plan', () => {
	const plan = macOSReleasePlan({
		appPath: APP_PATH,
		helperPath: HELPER_PATH,
		archivePath: `${ARCHIVE_DIR}/test.zip`,
	})

	const tools = {
		accessSync: () => {
			throw new Error('Helper not found')
		},
		mkdirSync: () => {
			throw new Error('Should not reach mkdir')
		},
		spawnSync: (cmd, args) => {
			throw new Error('Should not reach spawnSync')
		},
	}

	const result = runMacOSReleasePlan(plan, tools)
	assert.equal(result.step, 'verify-helper')
	assert.equal(result.exitCode, 1)
})

test('stops at the first nonzero exit code in a macOS plan', () => {
	const plan = macOSReleasePlan({
		appPath: APP_PATH,
		helperPath: HELPER_PATH,
		archivePath: `${ARCHIVE_DIR}/test.zip`,
	})

	let callCount = 0
	const tools = {
		accessSync: () => {
			// Helper exists.
		},
		mkdirSync: () => {
			// Directory created.
		},
		spawnSync: (cmd, args) => {
			callCount++
			if (callCount === 3) {
				// Fail at spctl (the third spawnSync call after codesign and stapler).
				return { status: 3 }
			}
			return { status: 0 }
		},
	}

	const result = runMacOSReleasePlan(plan, tools)
	assert.equal(result.step, 'verify-spctl')
	assert.equal(result.exitCode, 3)
	assert.equal(callCount, 3) // codesign, stapler, spctl
})

test('requires VERSION environment variable', () => {
	assert.throws(
		() =>
			runPackagingCommand(['package-macos'], { RUNNER_ARCH: 'ARM64' }, () => {
				throw new Error('Should not be called')
			}),
		/VERSION environment variable is required/,
	)
})

test('requires RUNNER_ARCH environment variable', () => {
	assert.throws(
		() =>
			runPackagingCommand(['package-macos'], { VERSION: '0.1.0' }, () => {
				throw new Error('Should not be called')
			}),
		/RUNNER_ARCH environment variable is required/,
	)
})

test('runs package-macos command and reports success', () => {
	let spawnCalls = []
	const spawnSync = (cmd, args, opts) => {
		spawnCalls.push({ cmd, args })
		return { status: 0 }
	}

	const tools = {
		accessSync: () => {
			// Helper exists.
		},
		mkdirSync: () => {
			// Directory created.
		},
	}

	runPackagingCommand(
		['package-macos'],
		{ VERSION: '0.1.0', RUNNER_ARCH: 'ARM64' },
		spawnSync,
		tools,
	)

	assert.equal(spawnCalls.length, 4)
	assert.equal(spawnCalls[0].cmd, 'codesign')
	assert.equal(spawnCalls[1].cmd, 'xcrun')
	assert.equal(spawnCalls[2].cmd, 'spctl')
	assert.equal(spawnCalls[3].cmd, 'ditto')
})

test('runs package-macos and throws on codesign failure', () => {
	const spawnSync = (cmd, args, opts) => {
		if (cmd === 'codesign') {
			return { status: 1 }
		}
		return { status: 0 }
	}

	const tools = {
		accessSync: () => {
			// Helper exists.
		},
		mkdirSync: () => {
			// Directory created.
		},
	}

	assert.throws(
		() =>
			runPackagingCommand(
				['package-macos'],
				{ VERSION: '0.1.0', RUNNER_ARCH: 'ARM64' },
				spawnSync,
				tools,
			),
		error => {
			assert.match(error.message, /failed at step 'verify-codesign'/)
			return true
		},
	)
})

test('runs package-windows command and spawns pwsh', () => {
	let spawnCalls = []
	const spawnSync = (cmd, args, opts) => {
		spawnCalls.push({ cmd, args })
		if (cmd === 'pwsh') {
			return { status: 0 }
		}
		throw new Error(`Unexpected command: ${cmd}`)
	}

	runPackagingCommand(['package-windows'], { VERSION: '0.1.0', RUNNER_ARCH: 'x64' }, spawnSync)

	assert.equal(spawnCalls.length, 1)
	assert.equal(spawnCalls[0].cmd, 'pwsh')
	assert.equal(spawnCalls[0].args[0], '-NoProfile')
	assert.equal(spawnCalls[0].args[1], '-NonInteractive')
	assert.equal(spawnCalls[0].args[2], '-Command')
	assert.match(spawnCalls[0].args[3], /Compress-Archive/)
	assert.match(spawnCalls[0].args[3], /\$ErrorActionPreference = 'stop'/)
})

test('runs package-windows and throws on failure', () => {
	const spawnSync = (cmd, args, opts) => {
		if (cmd === 'pwsh') {
			return { status: 1 }
		}
		throw new Error(`Unexpected command: ${cmd}`)
	}

	assert.throws(
		() =>
			runPackagingCommand(['package-windows'], { VERSION: '0.1.0', RUNNER_ARCH: 'x64' }, spawnSync),
		/Windows release packaging failed with exit code 1/,
	)
})

test('rejects an unknown command', () => {
	assert.throws(
		() => runPackagingCommand(['unknown'], { VERSION: '0.1.0', RUNNER_ARCH: 'ARM64' }, () => {}),
		/Unknown command 'unknown'/,
	)
})

test('rejects an empty command', () => {
	assert.throws(
		() => runPackagingCommand([], { VERSION: '0.1.0', RUNNER_ARCH: 'ARM64' }, () => {}),
		/Unknown command ''/,
	)
})

// SPDX-FileCopyrightText: 2026 ChattoCorp GmbH
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical names for the macOS ScreenCaptureKit capture helper bundle.
 *
 * Both the packaged Electron runtime (`main.mjs`, which ships inside the
 * app's asar archive) and the build-time helper embedder
 * (`scripts/macos-capture-helper.mjs`, which the packager excludes from the
 * shipped app) need these exact names to agree: the runtime resolves the
 * helper's path at launch, and the build step writes the helper to that same
 * path. This file lives outside `scripts/` and `native/` so both sides can
 * import it without pulling build-only tooling into the shipped app.
 *
 * Do not rename either value without also checking
 * `apps/desktop/native/macos-capture-probe/Package.swift`, whose `name`
 * fields set the actual Swift executable name that
 * `macOSCaptureHelperExecutable` must match for the build to find it.
 */

/** The nested helper app bundle name, e.g. `Contents/Helpers/<name>`. */
export const macOSCaptureHelperAppName = "Chatto Capture Helper.app";

/** The helper executable name inside the bundle's `Contents/MacOS/`. */
export const macOSCaptureHelperExecutable = "chatto-macos-capture-probe";

/**
 * Windows release signing checks for the Chatto Desktop bundle.
 *
 * `release.yml` runs two Windows-only checks around the signing step:
 *
 * 1. Before the build, it makes sure that every Windows signing setting has a
 *    value. Only the names of the settings that have no value are reported.
 *    A value is never read, compared, or printed.
 * 2. After the signing step, it makes sure that each executable file in the
 *    bundle has a valid, timestamped signature, and that the main binary
 *    `chatto-desktop.exe` has the expected publisher.
 *
 * The workflow keeps only the artifact input and output: it collects the
 * signature records with `Get-AuthenticodeSignature` and writes them as JSON.
 * This module holds the decisions, so a test can run them on any platform.
 *
 * ## Interface
 *
 * `check-settings` reads the seven `CHATTO_WINDOWS_*` variables from the
 * environment. `verify-signatures` reads a signature report with this shape:
 *
 * ```json
 * {
 *   "mainBinaryPath": "D:\\a\\chatto\\apps\\desktop\\dist\\windows\\chatto-desktop.exe",
 *   "mainBinaryPresent": true,
 *   "files": [
 *     { "fullName": "…\\chatto-desktop.exe", "status": "Valid",
 *       "publisher": "CN=ChattoCorp GmbH, …", "hasTimestamp": true }
 *   ]
 * }
 * ```
 *
 * `status` is the name of the `SignatureStatus` value that
 * `Get-AuthenticodeSignature` reports. `publisher` is the subject of the
 * signer certificate, or `null` when the file has no signer certificate.
 * `hasTimestamp` is true when the signature has a timestamper certificate.
 *
 * ## Invariants
 *
 * - No function reads `process.env`. The environment is always an argument, so
 *   a test can supply one.
 * - A failure message reports the name of a setting, never its value. The
 *   values of these settings are credentials or identities.
 * - `verifyWindowsSignatures` stops at the first file that fails. The workflow
 *   step behaved this way before this module existed: the runner puts
 *   `$ErrorActionPreference = 'stop'` in front of each `pwsh` script, which
 *   makes the `Write-Error` in the loop stop the script.
 * - The failure and summary messages keep the text that the PowerShell step
 *   wrote, `True` and `False` included, because PowerShell writes a Boolean
 *   this way.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The Windows signing settings that the release workflow requires.
 *
 * The order of this list is the order of the names in the failure message.
 */
export const WINDOWS_SIGNING_SETTINGS = Object.freeze([
  "CHATTO_WINDOWS_AZURE_CLIENT_ID",
  "CHATTO_WINDOWS_AZURE_TENANT_ID",
  "CHATTO_WINDOWS_AZURE_SUBSCRIPTION_ID",
  "CHATTO_WINDOWS_SIGNING_ENDPOINT",
  "CHATTO_WINDOWS_SIGNING_ACCOUNT_NAME",
  "CHATTO_WINDOWS_CERTIFICATE_PROFILE_NAME",
  "CHATTO_WINDOWS_EXPECTED_PUBLISHER",
]);

/** The file name of the desktop application in the Windows bundle. */
const MAIN_BINARY_NAME = "chatto-desktop.exe";

/**
 * Tell whether a value is absent or contains only white space.
 *
 * This is the rule that `[string]::IsNullOrWhiteSpace` applied.
 */
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

/**
 * Compare two values that can be absent, without case.
 *
 * This is the rule that `[string]::Equals(…, OrdinalIgnoreCase)` applied: two
 * absent values are equal, an absent value and a string are not.
 *
 * Windows does not keep an environment variable that has an empty value, so an
 * unset setting reached PowerShell as `$null`. `normalisePublisher` makes an
 * empty string absent again for the same reason.
 */
function equalsIgnoringCase(left, right) {
  if (left === undefined || left === null) {
    return right === undefined || right === null;
  }
  if (right === undefined || right === null) {
    return false;
  }
  return String(left).toUpperCase() === String(right).toUpperCase();
}

/** Make an absent or empty publisher one value: `null`. */
function normalisePublisher(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

/** Write a Boolean as PowerShell writes it, so the messages do not change. */
function powerShellBoolean(value) {
  return value ? "True" : "False";
}

/**
 * Report the Windows signing settings that have no value.
 *
 * @param {Record<string, string | undefined>} environment - The environment to
 *   read the settings from. This function never reads `process.env`.
 * @returns {string[]} The names of the settings that are absent or blank, in
 *   the order of `WINDOWS_SIGNING_SETTINGS`. The values are never returned.
 */
export function missingWindowsSigningSettings(environment) {
  return WINDOWS_SIGNING_SETTINGS.filter((name) => isBlank(environment[name]));
}

/**
 * Check that each Windows signing setting has a value.
 *
 * @param {Record<string, string | undefined>} environment - The environment to
 *   read the settings from.
 * @throws {Error} When one or more settings have no value. The message lists
 *   the names of those settings only.
 */
export function checkWindowsSigningSettings(environment) {
  const missing = missingWindowsSigningSettings(environment);
  if (missing.length > 0) {
    throw new Error(
      `The following Windows release settings are not configured: ${missing.join(", ")}`,
    );
  }
}

/**
 * Tell why one signature record fails, or that it passes.
 *
 * A file fails when its signature is not valid, when it has no timestamp, or
 * when it is the main binary and its publisher is not the expected publisher.
 * A bundled third-party library keeps its own publisher.
 *
 * @param {{fullName: string, status: string, publisher?: string | null,
 *   hasTimestamp: boolean}} record - One signature record from the report.
 * @param {{mainBinaryPath: string, expectedPublisher: string | null}} options -
 *   The path of the main binary, and the publisher that the main binary must
 *   report.
 * @returns {string | null} The failure message, or `null` when the file passes.
 */
export function windowsSignatureFailure(record, options) {
  const publisher = normalisePublisher(record.publisher);
  const hasExpectedPublisher = equalsIgnoringCase(
    publisher,
    options.expectedPublisher,
  );
  const requiresExpectedPublisher = equalsIgnoringCase(
    record.fullName,
    options.mainBinaryPath,
  );

  const fails =
    record.status !== "Valid" ||
    (requiresExpectedPublisher && !hasExpectedPublisher) ||
    !record.hasTimestamp;
  if (!fails) {
    return null;
  }

  return (
    `${record.fullName}: status=${record.status}, ` +
    `publisher='${publisher ?? ""}', ` +
    `timestamped=${powerShellBoolean(record.hasTimestamp)}`
  );
}

/**
 * Check the signature report of a Windows bundle.
 *
 * @param {{mainBinaryPath: string, mainBinaryPresent: boolean,
 *   files: object[]}} report - The report that the workflow step collects.
 * @param {Record<string, string | undefined>} environment - The environment
 *   that holds `CHATTO_WINDOWS_EXPECTED_PUBLISHER`.
 * @returns {string} The summary line to write when every file passes.
 * @throws {Error} When the report has the wrong shape, when the bundle holds
 *   no executable file, when the bundle holds no main binary, or when a file
 *   fails. The check stops at the first file that fails.
 */
export function verifyWindowsSignatures(report, environment) {
  if (report === null || typeof report !== "object") {
    throw new Error("The Windows signature report is not an object.");
  }
  if (!Array.isArray(report.files)) {
    throw new Error("The Windows signature report has no list of files.");
  }
  if (report.files.length === 0) {
    throw new Error(
      "The Windows bundle contains no executable files to verify.",
    );
  }
  if (!report.mainBinaryPresent) {
    throw new Error(
      `The Windows bundle does not contain ${MAIN_BINARY_NAME}.`,
    );
  }

  const expectedPublisher = normalisePublisher(
    environment.CHATTO_WINDOWS_EXPECTED_PUBLISHER,
  );
  for (const record of report.files) {
    const failure = windowsSignatureFailure(record, {
      mainBinaryPath: report.mainBinaryPath,
      expectedPublisher,
    });
    if (failure !== null) {
      throw new Error(failure);
    }
  }

  return (
    `Verified ${report.files.length} valid, timestamped Windows executable ` +
    `signatures; ${MAIN_BINARY_NAME} is published by ` +
    `'${expectedPublisher ?? ""}'.`
  );
}

/**
 * Run one command of this module.
 *
 * @param {string[]} argv - The command and its arguments.
 * @param {Record<string, string | undefined>} environment - The environment to
 *   read the settings from.
 * @param {(path: string) => object} readReport - Reads and parses the
 *   signature report. The caller supplies it, so a test needs no file.
 * @returns {string | null} The line to write when the command passes, or
 *   `null` when the command writes nothing.
 * @throws {Error} When the command is unknown, when an argument is missing, or
 *   when the check fails.
 */
export function runWindowsSigningCommand(argv, environment, readReport) {
  const [command, ...rest] = argv;
  switch (command) {
    case "check-settings":
      checkWindowsSigningSettings(environment);
      return null;
    case "verify-signatures": {
      const [reportPath] = rest;
      if (reportPath === undefined) {
        throw new Error(
          "verify-signatures needs the path of the signature report.",
        );
      }
      return verifyWindowsSignatures(readReport(reportPath), environment);
    }
    default:
      throw new Error(
        `Unknown command '${command ?? ""}'. Use check-settings or verify-signatures.`,
      );
  }
}

// The command line entry point. `release.yml` runs it on the Windows runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const message = runWindowsSigningCommand(
      process.argv.slice(2),
      process.env,
      (path) => JSON.parse(readFileSync(path, "utf8")),
    );
    if (message !== null) {
      console.log(message);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  WINDOWS_SIGNING_SETTINGS,
  checkWindowsSigningSettings,
  missingWindowsSigningSettings,
  runWindowsSigningCommand,
  verifyWindowsSignatures,
  windowsSignatureFailure,
} from "./windows-signing.mjs";

const BUNDLE = "D:\\a\\chatto\\apps\\desktop\\dist\\windows";
const MAIN_BINARY = `${BUNDLE}\\chatto-desktop.exe`;
const PUBLISHER = "CN=ChattoCorp GmbH, O=ChattoCorp GmbH, C=DE";

/** A complete set of settings, with a stand-in value for each name. */
function completeSettings() {
  return Object.fromEntries(
    WINDOWS_SIGNING_SETTINGS.map((name) => [name, `value-of-${name}`]),
  );
}

/** A report that passes, with the main binary and one bundled library. */
function passingReport() {
  return {
    mainBinaryPath: MAIN_BINARY,
    mainBinaryPresent: true,
    files: [
      {
        fullName: MAIN_BINARY,
        status: "Valid",
        publisher: PUBLISHER,
        hasTimestamp: true,
      },
      {
        fullName: `${BUNDLE}\\resources\\vk_swiftshader.dll`,
        status: "Valid",
        publisher: "CN=Microsoft Corporation, C=US",
        hasTimestamp: true,
      },
    ],
  };
}

test("reports no missing setting when every setting has a value", () => {
  assert.deepEqual(missingWindowsSigningSettings(completeSettings()), []);
});

test("reports the names of settings that are absent or blank", () => {
  const environment = completeSettings();
  delete environment.CHATTO_WINDOWS_AZURE_TENANT_ID;
  environment.CHATTO_WINDOWS_SIGNING_ENDPOINT = "   ";
  environment.CHATTO_WINDOWS_EXPECTED_PUBLISHER = "";

  assert.deepEqual(missingWindowsSigningSettings(environment), [
    "CHATTO_WINDOWS_AZURE_TENANT_ID",
    "CHATTO_WINDOWS_SIGNING_ENDPOINT",
    "CHATTO_WINDOWS_EXPECTED_PUBLISHER",
  ]);
});

test("accepts a complete set of settings", () => {
  assert.doesNotThrow(() => checkWindowsSigningSettings(completeSettings()));
});

test("rejects incomplete settings and names no value", () => {
  const environment = completeSettings();
  environment.CHATTO_WINDOWS_AZURE_CLIENT_ID = "";

  assert.throws(
    () => checkWindowsSigningSettings(environment),
    (error) => {
      assert.equal(
        error.message,
        "The following Windows release settings are not configured: " +
          "CHATTO_WINDOWS_AZURE_CLIENT_ID",
      );
      for (const value of Object.values(environment)) {
        assert.equal(value === "" || !error.message.includes(value), true);
      }
      return true;
    },
  );
});

test("accepts a valid, timestamped signature on the main binary", () => {
  assert.equal(
    windowsSignatureFailure(
      {
        fullName: MAIN_BINARY,
        status: "Valid",
        publisher: PUBLISHER,
        hasTimestamp: true,
      },
      { mainBinaryPath: MAIN_BINARY, expectedPublisher: PUBLISHER },
    ),
    null,
  );
});

test("compares the path and the publisher without case", () => {
  assert.equal(
    windowsSignatureFailure(
      {
        fullName: MAIN_BINARY.toUpperCase(),
        status: "Valid",
        publisher: PUBLISHER.toLowerCase(),
        hasTimestamp: true,
      },
      { mainBinaryPath: MAIN_BINARY, expectedPublisher: PUBLISHER },
    ),
    null,
  );
});

test("accepts another publisher on a bundled library", () => {
  assert.equal(
    windowsSignatureFailure(
      {
        fullName: `${BUNDLE}\\d3dcompiler_47.dll`,
        status: "Valid",
        publisher: "CN=Microsoft Corporation, C=US",
        hasTimestamp: true,
      },
      { mainBinaryPath: MAIN_BINARY, expectedPublisher: PUBLISHER },
    ),
    null,
  );
});

test("rejects another publisher on the main binary", () => {
  assert.equal(
    windowsSignatureFailure(
      {
        fullName: MAIN_BINARY,
        status: "Valid",
        publisher: "CN=Somebody Else, C=DE",
        hasTimestamp: true,
      },
      { mainBinaryPath: MAIN_BINARY, expectedPublisher: PUBLISHER },
    ),
    `${MAIN_BINARY}: status=Valid, publisher='CN=Somebody Else, C=DE', ` +
      "timestamped=True",
  );
});

test("rejects a signature that is not valid", () => {
  assert.equal(
    windowsSignatureFailure(
      {
        fullName: `${BUNDLE}\\resources\\app.node`,
        status: "NotSigned",
        publisher: null,
        hasTimestamp: false,
      },
      { mainBinaryPath: MAIN_BINARY, expectedPublisher: PUBLISHER },
    ),
    `${BUNDLE}\\resources\\app.node: status=NotSigned, publisher='', ` +
      "timestamped=False",
  );
});

test("rejects a valid signature that has no timestamp", () => {
  assert.equal(
    windowsSignatureFailure(
      {
        fullName: `${BUNDLE}\\ffmpeg.dll`,
        status: "Valid",
        publisher: "CN=Microsoft Corporation, C=US",
        hasTimestamp: false,
      },
      { mainBinaryPath: MAIN_BINARY, expectedPublisher: PUBLISHER },
    ),
    `${BUNDLE}\\ffmpeg.dll: status=Valid, ` +
      "publisher='CN=Microsoft Corporation, C=US', timestamped=False",
  );
});

test("summarises a bundle in which every file passes", () => {
  assert.equal(
    verifyWindowsSignatures(passingReport(), {
      CHATTO_WINDOWS_EXPECTED_PUBLISHER: PUBLISHER,
    }),
    "Verified 2 valid, timestamped Windows executable signatures; " +
      `chatto-desktop.exe is published by '${PUBLISHER}'.`,
  );
});

test("rejects a report that is not an object", () => {
  assert.throws(
    () => verifyWindowsSignatures(null, {}),
    /report is not an object/,
  );
});

test("rejects a report that has no list of files", () => {
  assert.throws(
    () => verifyWindowsSignatures({ mainBinaryPresent: true }, {}),
    /report has no list of files/,
  );
});

test("rejects a bundle that holds no executable file", () => {
  const report = passingReport();
  report.files = [];

  assert.throws(
    () =>
      verifyWindowsSignatures(report, {
        CHATTO_WINDOWS_EXPECTED_PUBLISHER: PUBLISHER,
      }),
    /contains no executable files to verify/,
  );
});

test("rejects a bundle that holds no main binary", () => {
  const report = passingReport();
  report.mainBinaryPresent = false;

  assert.throws(
    () =>
      verifyWindowsSignatures(report, {
        CHATTO_WINDOWS_EXPECTED_PUBLISHER: PUBLISHER,
      }),
    /does not contain chatto-desktop\.exe/,
  );
});

test("stops at the first file that fails", () => {
  const report = passingReport();
  report.files[0].hasTimestamp = false;
  report.files[1].status = "HashMismatch";

  assert.throws(
    () =>
      verifyWindowsSignatures(report, {
        CHATTO_WINDOWS_EXPECTED_PUBLISHER: PUBLISHER,
      }),
    (error) => {
      assert.equal(
        error.message,
        `${MAIN_BINARY}: status=Valid, publisher='${PUBLISHER}', ` +
          "timestamped=False",
      );
      return true;
    },
  );
});

test("runs the settings check and writes nothing when it passes", () => {
  assert.equal(
    runWindowsSigningCommand(["check-settings"], completeSettings(), () => {
      throw new Error("the settings check must read no report");
    }),
    null,
  );
});

test("runs the signature check on the report at the given path", () => {
  const paths = [];

  const summary = runWindowsSigningCommand(
    ["verify-signatures", "report.json"],
    { CHATTO_WINDOWS_EXPECTED_PUBLISHER: PUBLISHER },
    (path) => {
      paths.push(path);
      return passingReport();
    },
  );

  assert.deepEqual(paths, ["report.json"]);
  assert.match(summary, /^Verified 2 valid, timestamped/);
});

test("rejects a signature check that has no report path", () => {
  assert.throws(
    () => runWindowsSigningCommand(["verify-signatures"], {}, () => ({})),
    /needs the path of the signature report/,
  );
});

test("rejects an unknown command", () => {
  assert.throws(
    () => runWindowsSigningCommand(["sign-everything"], {}, () => ({})),
    /Unknown command 'sign-everything'/,
  );
});

test("rejects an empty command line", () => {
  assert.throws(
    () => runWindowsSigningCommand([], {}, () => ({})),
    /Unknown command ''/,
  );
});

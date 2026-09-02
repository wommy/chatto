#!/usr/bin/env node

/**
 * Smoke check for a published container image.
 *
 * ## Why this module exists
 *
 * A release moves floating tags. `chatto-client:latest` and
 * `chatto-client:next` point at an image that no step has started. Issue #38
 * decided that a floating tag must move only after the release proved that
 * the immutable `{version}` image works, so this module supplies that proof.
 * The release workflow pulls `{version}`, runs this check against it, and
 * moves the floating tags onto the same digest with
 * `docker buildx imagetools create`.
 *
 * ## What the check does
 *
 * 1. Pull the image. A registry needs a short time to serve a manifest that
 *    a previous step pushed, so the pull retries a bounded number of times.
 * 2. Start one container from that image, with the command that the caller
 *    gives, and publish the container port on the loopback address.
 * 3. Request the probe path until the answer is 200, or until the attempts
 *    are used.
 * 4. If the caller gives an expected version, read the version document and
 *    compare its `version` property with that value.
 * 5. Remove the container.
 *
 * Each failure is a failure. The check never reports success when it could
 * not pull the image, could not start the container, got no 200 answer, or
 * read a different version. A tolerant retry that ends in a pass would make
 * the gate an empty ceremony.
 *
 * ## The interface serves both Chatto images
 *
 * The caller gives the image reference, the command arguments, the probe
 * path, and the container port. The client image needs no command, answers
 * on port 80, and serves `/` from nginx. The server image needs a command
 * and a configuration file, answers on port 4000, and serves `/readyz`.
 * Issue #52 uses this module for the server image.
 *
 * ## Lifecycle
 *
 * The module starts one container and removes it. It writes no files, and it
 * reads no repository state. All input comes from the command line.
 *
 * ## Command line
 *
 *     node tools/smoke-check-image.mjs \
 *       --image ghcr.io/chattocorp/chatto-client:1.2.3 \
 *       --port 80 \
 *       --probe-path / \
 *       --expect-version 1.2.3
 *
 * Use `--arg` one time for each word of the container command. Use
 * `--attempts` and `--delay-ms` to bound the wait. Give the workflow step a
 * `timeout-minutes` value as well, because the `release` job sets no timeout
 * of its own.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/** Probe attempts, when the caller gives no other value. */
export const DEFAULT_ATTEMPTS = 30;

/** Milliseconds between two attempts. */
export const DEFAULT_DELAY_MS = 2000;

/** Pull attempts, when the caller gives no other value. */
export const DEFAULT_PULL_ATTEMPTS = 5;

/** Path of the SvelteKit version document in the client image. */
export const DEFAULT_VERSION_PATH = "/_app/version.json";

/**
 * Milliseconds that one HTTP request gets. The probe loop keeps its own
 * bound, and this value stops one request holding that loop.
 */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * @typedef {object} SmokeCheckOptions
 * @property {string} image Full image reference, with its tag or digest.
 * @property {number|string} port Container port that answers the probe.
 * @property {string[]} [command] Command arguments for the container. The
 *   client image needs none. The server image needs its subcommand and the
 *   path of its configuration file.
 * @property {string} [probePath] Path that must answer 200. Default `/`.
 * @property {string} [expectVersion] Version that the version document must
 *   hold. The check reads no version document when this is absent.
 * @property {string} [versionPath] Path of the version document.
 * @property {number|string} [attempts] Probe attempts before the check fails.
 * @property {number|string} [pullAttempts] Pull attempts before the check
 *   fails.
 * @property {number|string} [delayMs] Milliseconds between two attempts.
 * @property {string} [containerName] Name for the container. The module
 *   makes a unique name when the caller gives none.
 */

/**
 * @typedef {object} SmokeCheckDependencies
 * @property {(args: string[]) => {status: number, stdout: string,
 *   stderr: string}} docker Run the `docker` command with these arguments.
 * @property {(url: string) => Promise<{status: number, body: string}>} request
 *   Request one URL. A transport failure must reject.
 * @property {(ms: number) => Promise<void>} [sleep] Wait between attempts.
 * @property {(message: string) => void} [log] Write one progress line.
 */

/** Give the arguments that pull an image. */
export function pullArgs(image) {
  return ["pull", image];
}

/**
 * Give the arguments that start the container.
 *
 * The container publishes its port on `127.0.0.1` with a port that the host
 * chooses, so two checks in one job cannot collide. The command arguments
 * come after the image, which is where Docker expects them.
 */
export function runArgs({ image, containerName, port, command = [] }) {
  return [
    "run",
    "--detach",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1::${port}/tcp`,
    image,
    ...command,
  ];
}

/** Give the arguments that read the published address of a container port. */
export function portArgs({ containerName, port }) {
  return ["port", containerName, `${port}/tcp`];
}

/** Give the arguments that show the last lines of the container log. */
export function logsArgs(containerName) {
  return ["logs", "--tail", "50", containerName];
}

/** Give the arguments that remove the container. */
export function removeArgs(containerName) {
  return ["rm", "--force", "--volumes", containerName];
}

/**
 * Give the base URL for a published container port.
 *
 * `docker port` writes one line for each address that holds the port, such
 * as `127.0.0.1:49154`. The module binds the loopback address only, so it
 * uses the first line and keeps the port number.
 *
 * @param {string} stdout Output of `docker port`.
 * @returns {string} A base URL such as `http://127.0.0.1:49154`.
 * @throws {Error} If the output holds no port number.
 */
export function parsePublishedBaseUrl(stdout) {
  for (const line of String(stdout).split("\n")) {
    const match = /:(\d{1,5})$/.exec(line.trim());
    if (match) return `http://127.0.0.1:${match[1]}`;
  }
  throw new Error(`Could not read a published port from: ${String(stdout).trim()}`);
}

/**
 * Give the complete options, with the defaults filled in.
 *
 * @param {SmokeCheckOptions} options
 * @returns {Required<SmokeCheckOptions>}
 * @throws {TypeError} If an option is absent or outside its range.
 */
export function normalizeOptions(options) {
  const image = String(options.image ?? "").trim();
  if (!image) throw new TypeError("image is required");

  const port = positiveInteger(options.port, "port");
  if (port > 65535) throw new TypeError(`port is out of range: ${options.port}`);

  const command = options.command ?? [];
  if (!Array.isArray(command)) {
    throw new TypeError("command must be an array of arguments");
  }

  const probePath = options.probePath ?? "/";
  if (!probePath.startsWith("/")) {
    throw new TypeError(`probePath must start with a slash: ${probePath}`);
  }

  const versionPath = options.versionPath ?? DEFAULT_VERSION_PATH;
  if (!versionPath.startsWith("/")) {
    throw new TypeError(`versionPath must start with a slash: ${versionPath}`);
  }

  return {
    image,
    port,
    command: command.map(String),
    probePath,
    versionPath,
    expectVersion: options.expectVersion ?? "",
    attempts: positiveInteger(options.attempts ?? DEFAULT_ATTEMPTS, "attempts"),
    pullAttempts: positiveInteger(
      options.pullAttempts ?? DEFAULT_PULL_ATTEMPTS,
      "pullAttempts",
    ),
    delayMs: nonNegativeInteger(options.delayMs ?? DEFAULT_DELAY_MS, "delayMs"),
    containerName: options.containerName ?? `chatto-smoke-${randomUUID()}`,
  };
}

/**
 * Pull the image, start it, probe it, and remove the container.
 *
 * @param {SmokeCheckOptions} options
 * @param {SmokeCheckDependencies} dependencies
 * @returns {Promise<{baseUrl: string, attempts: number, version: string}>}
 *   The address that answered, the number of probe attempts that the check
 *   used, and the version that it read. The version is empty when the caller
 *   gave no expected version.
 * @throws {Error} If any step of the check fails.
 */
export async function smokeCheckImage(options, dependencies) {
  const plan = normalizeOptions(options);
  const { docker, request } = dependencies;
  const sleep = dependencies.sleep ?? defaultSleep;
  const log = dependencies.log ?? (() => {});

  await pullImage(plan, docker, sleep, log);

  const started = docker(runArgs(plan));
  if (started.status !== 0) {
    throw new Error(
      `Could not start ${plan.image}: ${firstMessage(started)}`.trim(),
    );
  }

  try {
    const baseUrl = parsePublishedBaseUrl(readPublishedPort(plan, docker));
    log(`Container ${plan.containerName} answers on ${baseUrl}`);

    const attempts = await waitForOk(
      `${baseUrl}${plan.probePath}`,
      plan,
      request,
      sleep,
      log,
    );

    const version = plan.expectVersion
      ? await assertVersion(`${baseUrl}${plan.versionPath}`, plan, request)
      : "";

    return { baseUrl, attempts, version };
  } catch (error) {
    throw new Error(`${error.message}\n${containerLog(plan, docker)}`);
  } finally {
    const removed = docker(removeArgs(plan.containerName));
    if (removed.status !== 0) {
      log(`Could not remove container ${plan.containerName}.`);
    }
  }
}

/**
 * Pull the image, and try again while the registry is not ready.
 *
 * The release workflow pushes `{version}` in an earlier step, and a registry
 * can need a short time before it serves that manifest. The retry covers that
 * time only. When the attempts are used, the check fails: an image that
 * cannot be pulled must never let a floating tag move.
 */
async function pullImage(plan, docker, sleep, log) {
  let last = { status: 1, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= plan.pullAttempts; attempt += 1) {
    last = docker(pullArgs(plan.image));
    if (last.status === 0) {
      log(`Pulled ${plan.image} on attempt ${attempt}.`);
      return;
    }
    log(`Pull attempt ${attempt} of ${plan.pullAttempts} failed.`);
    if (attempt < plan.pullAttempts) await sleep(plan.delayMs);
  }
  throw new Error(
    `Could not pull ${plan.image} in ${plan.pullAttempts} attempts: ${firstMessage(last)}`.trim(),
  );
}

function readPublishedPort(plan, docker) {
  const published = docker(portArgs(plan));
  if (published.status !== 0) {
    throw new Error(
      `Could not read the published port of ${plan.containerName}: ${firstMessage(published)}`.trim(),
    );
  }
  return published.stdout;
}

/**
 * Request the probe URL until it answers 200.
 *
 * A transport failure and a status that is not 200 get the same answer: the
 * check waits and tries again. The container needs a short time before it
 * listens, and both conditions occur in that time.
 */
async function waitForOk(url, plan, request, sleep, log) {
  let reason = "no attempt was made";
  for (let attempt = 1; attempt <= plan.attempts; attempt += 1) {
    try {
      const answer = await request(url);
      if (answer.status === 200) {
        log(`GET ${plan.probePath} answered 200 on attempt ${attempt}.`);
        return attempt;
      }
      reason = `status ${answer.status}`;
    } catch (error) {
      reason = error.message;
    }
    if (attempt < plan.attempts) await sleep(plan.delayMs);
  }
  throw new Error(
    `GET ${url} did not answer 200 in ${plan.attempts} attempts: ${reason}`,
  );
}

/**
 * Read the version document, and compare it with the expected version.
 *
 * The probe proves that a server answers. This proves that the server holds
 * the bundle of this release. Without it the check passes for each image that
 * starts an HTTP server, which is not what a floating tag needs.
 *
 * The check makes one request, and it does not try again. The probe already
 * proved that the server answers, and a document that holds a different
 * version does not change.
 */
async function assertVersion(url, plan, request) {
  const answer = await request(url);
  if (answer.status !== 200) {
    throw new Error(`GET ${url} answered ${answer.status}, expected 200`);
  }

  let document;
  try {
    document = JSON.parse(answer.body);
  } catch (error) {
    throw new Error(`GET ${url} did not answer JSON: ${error.message}`);
  }

  if (document?.version !== plan.expectVersion) {
    throw new Error(
      `${url} holds version ${JSON.stringify(document?.version)},` +
        ` expected ${JSON.stringify(plan.expectVersion)}`,
    );
  }
  return document.version;
}

function containerLog(plan, docker) {
  const logs = docker(logsArgs(plan.containerName));
  const text = `${logs.stdout ?? ""}${logs.stderr ?? ""}`.trim();
  return text ? `Container log:\n${text}` : "The container wrote no log.";
}

function firstMessage(result) {
  return `${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim();
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TypeError(
      `Expected a positive integer for ${name}, got: ${value}`,
    );
  }
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(
      `Expected a whole number of milliseconds for ${name}, got: ${value}`,
    );
  }
  return parsed;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run the `docker` command. This is the boundary that the tests replace. */
export function runDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) {
    return { status: 1, stdout: "", stderr: result.error.message };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Request one URL. This is the other boundary that the tests replace. */
export async function requestUrl(url) {
  const answer = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: answer.status, body: await answer.text() };
}

/**
 * Read the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {SmokeCheckOptions}
 * @throws {TypeError} If an option is unknown, or if `--image` or `--port` is
 *   absent.
 */
export function parseArgs(argv) {
  const options = { command: [] };
  const single = {
    "--image": "image",
    "--port": "port",
    "--probe-path": "probePath",
    "--expect-version": "expectVersion",
    "--version-path": "versionPath",
    "--attempts": "attempts",
    "--pull-attempts": "pullAttempts",
    "--delay-ms": "delayMs",
    "--container-name": "containerName",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === "--arg") {
      if (value === undefined) throw new TypeError("--arg needs a value");
      options.command.push(value);
      index += 1;
    } else if (single[option]) {
      if (value === undefined) throw new TypeError(`${option} needs a value`);
      options[single[option]] = value;
      index += 1;
    } else {
      throw new TypeError(`Unknown option: ${option}`);
    }
  }

  if (options.image === undefined) throw new TypeError("--image is required");
  if (options.port === undefined) throw new TypeError("--port is required");
  return options;
}

const USAGE =
  "usage: node tools/smoke-check-image.mjs --image <ref> --port <port>" +
  " [--probe-path <path>] [--expect-version <version>]" +
  " [--version-path <path>] [--attempts <n>] [--pull-attempts <n>]" +
  " [--delay-ms <ms>] [--arg <value>]\n";

async function main(argv) {
  try {
    const options = parseArgs(argv);
    const result = await smokeCheckImage(options, {
      docker: runDocker,
      request: requestUrl,
      log: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(
      `${options.image} started and answered on ${result.baseUrl}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error instanceof TypeError) process.stderr.write(USAGE);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}

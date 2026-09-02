import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_VERSION_PATH,
  logsArgs,
  normalizeOptions,
  parseArgs,
  parsePublishedBaseUrl,
  portArgs,
  pullArgs,
  removeArgs,
  runArgs,
  smokeCheckImage,
} from "./smoke-check-image.mjs";

const repositoryRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const modulePath = path.join(repositoryRoot, "tools/smoke-check-image.mjs");

const IMAGE = "ghcr.io/chattocorp/chatto-client:1.2.3";
const CONTAINER = "chatto-smoke-test";
const PUBLISHED = "127.0.0.1:49154\n";

const ok = { status: 0, stdout: "", stderr: "" };

/**
 * Make a `docker` stub.
 *
 * `docker/nats-wrapper_test.sh` replaces the final `exec` with a `printf` so
 * that the test can see the command without the real binary. This is the same
 * technique for a Node module: the stub records each command and gives the
 * answer that the test wants, so the tests exercise the real argument
 * construction, the real retry counts, and the real exit paths.
 */
function dockerStub(answers = {}) {
  const calls = [];
  const stub = (args) => {
    calls.push(args);
    const answer = answers[args[0]];
    if (typeof answer === "function") return answer(args, calls);
    if (answer) return answer;
    if (args[0] === "port") return { ...ok, stdout: PUBLISHED };
    return ok;
  };
  stub.calls = calls;
  stub.commands = () => calls.map((args) => args[0]);
  return stub;
}

/** Make a `request` stub that gives one answer for each path. */
function requestStub(answersByPath) {
  const urls = [];
  const request = async (url) => {
    urls.push(url);
    const { pathname } = new URL(url);
    const answer = answersByPath[pathname];
    if (answer === undefined) throw new Error(`ECONNREFUSED ${url}`);
    if (typeof answer === "function") return answer(urls);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  request.urls = urls;
  return request;
}

const noSleep = async () => {};

function baseOptions(overrides = {}) {
  return {
    image: IMAGE,
    port: 80,
    containerName: CONTAINER,
    delayMs: 0,
    ...overrides,
  };
}

test("the client image needs no command and probes the root path", async () => {
  const docker = dockerStub();
  const request = requestStub({
    "/": { status: 200, body: "<!doctype html>" },
    [DEFAULT_VERSION_PATH]: { status: 200, body: '{"version":"1.2.3"}' },
  });

  const result = await smokeCheckImage(
    baseOptions({ expectVersion: "1.2.3" }),
    { docker, request, sleep: noSleep },
  );

  assert.equal(result.baseUrl, "http://127.0.0.1:49154");
  assert.equal(result.attempts, 1);
  assert.equal(result.version, "1.2.3");
  assert.deepEqual(docker.calls[0], ["pull", IMAGE]);
  assert.deepEqual(docker.calls[1], [
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--publish",
    "127.0.0.1::80/tcp",
    IMAGE,
  ]);
  assert.deepEqual(docker.commands(), ["pull", "run", "port", "rm"]);
  assert.deepEqual(request.urls, [
    "http://127.0.0.1:49154/",
    `http://127.0.0.1:49154${DEFAULT_VERSION_PATH}`,
  ]);
});

test("the server image can give command arguments, a port and a probe path", async () => {
  // Issue #52 reuses this module. `docker/Dockerfile.goreleaser` gives the
  // server image a command and port 4000, and the server refuses to start
  // without a configuration file. The interface therefore takes the command
  // arguments, the probe path and the port from the caller.
  const docker = dockerStub();
  const request = requestStub({ "/readyz": { status: 200, body: "ok" } });

  const result = await smokeCheckImage(
    baseOptions({
      image: "ghcr.io/chattocorp/chatto:1.2.3",
      port: 4000,
      probePath: "/readyz",
      command: ["start", "-c", "/config/chatto.toml"],
    }),
    { docker, request, sleep: noSleep },
  );

  assert.equal(result.version, "");
  assert.deepEqual(docker.calls[1].slice(-4), [
    "ghcr.io/chattocorp/chatto:1.2.3",
    "start",
    "-c",
    "/config/chatto.toml",
  ]);
  assert.deepEqual(docker.calls[1].slice(4, 6), ["--publish", "127.0.0.1::4000/tcp"]);
  assert.deepEqual(request.urls, ["http://127.0.0.1:49154/readyz"]);
});

test("an image that cannot be pulled fails after the bounded attempts", async () => {
  const docker = dockerStub({
    pull: { status: 1, stdout: "", stderr: "denied: manifest unknown" },
  });
  const request = requestStub({});

  await assert.rejects(
    smokeCheckImage(baseOptions({ pullAttempts: 3 }), {
      docker,
      request,
      sleep: noSleep,
    }),
    /Could not pull .* in 3 attempts: denied: manifest unknown/,
  );

  assert.deepEqual(docker.commands(), ["pull", "pull", "pull"]);
});

test("a pull that succeeds after a registry delay does not fail the check", async () => {
  // The version tag is pushed in an earlier step, and a registry can need a
  // short time to serve it. The retry covers that time and nothing more.
  const docker = dockerStub({
    pull: (_args, calls) =>
      calls.filter((call) => call[0] === "pull").length < 3
        ? { status: 1, stdout: "", stderr: "manifest unknown" }
        : ok,
  });
  const request = requestStub({ "/": { status: 200, body: "ok" } });

  await smokeCheckImage(baseOptions({ pullAttempts: 5 }), {
    docker,
    request,
    sleep: noSleep,
  });

  assert.equal(docker.commands().filter((name) => name === "pull").length, 3);
});

test("a container that does not start fails, and starts no probe", async () => {
  const docker = dockerStub({
    run: { status: 125, stdout: "", stderr: "no matching manifest" },
  });
  const request = requestStub({ "/": { status: 200, body: "ok" } });

  await assert.rejects(
    smokeCheckImage(baseOptions(), { docker, request, sleep: noSleep }),
    /Could not start .*: no matching manifest/,
  );

  assert.deepEqual(docker.commands(), ["pull", "run"]);
  assert.deepEqual(request.urls, []);
});

test("a probe that never answers 200 fails, and the container is removed", async () => {
  const docker = dockerStub({
    logs: { status: 0, stdout: "nginx: emerg\n", stderr: "" },
  });
  const request = requestStub({ "/": { status: 502, body: "" } });

  await assert.rejects(
    smokeCheckImage(baseOptions({ attempts: 4 }), {
      docker,
      request,
      sleep: noSleep,
    }),
    (error) => {
      assert.match(error.message, /did not answer 200 in 4 attempts: status 502/);
      assert.match(error.message, /Container log:\nnginx: emerg/);
      return true;
    },
  );

  assert.equal(request.urls.length, 4);
  assert.deepEqual(docker.commands(), ["pull", "run", "port", "logs", "rm"]);
  assert.deepEqual(docker.calls.at(-1), removeArgs(CONTAINER));
});

test("a probe that answers late passes, and counts its attempts", async () => {
  const docker = dockerStub();
  const request = requestStub({
    "/": (urls) =>
      urls.length < 3
        ? Promise.reject(new Error("ECONNREFUSED"))
        : { status: 200, body: "ok" },
  });

  const result = await smokeCheckImage(baseOptions({ attempts: 10 }), {
    docker,
    request,
    sleep: noSleep,
  });

  assert.equal(result.attempts, 3);
});

test("a bundle with the wrong version fails the check", async () => {
  // A running nginx is not proof. `ci.yml` compares the same property against
  // the build output, and this compares it against the pulled image.
  const docker = dockerStub();
  const request = requestStub({
    "/": { status: 200, body: "ok" },
    [DEFAULT_VERSION_PATH]: { status: 200, body: '{"version":"1.2.2"}' },
  });

  await assert.rejects(
    smokeCheckImage(baseOptions({ expectVersion: "1.2.3" }), {
      docker,
      request,
      sleep: noSleep,
    }),
    /holds version "1.2.2", expected "1.2.3"/,
  );

  assert.ok(docker.commands().includes("rm"));
});

test("a version document that is not JSON fails the check", async () => {
  const docker = dockerStub();
  const request = requestStub({
    "/": { status: 200, body: "ok" },
    [DEFAULT_VERSION_PATH]: { status: 200, body: "<html>404</html>" },
  });

  await assert.rejects(
    smokeCheckImage(baseOptions({ expectVersion: "1.2.3" }), {
      docker,
      request,
      sleep: noSleep,
    }),
    /did not answer JSON/,
  );
});

test("a version document that is absent fails the check", async () => {
  const docker = dockerStub();
  const request = requestStub({
    "/": { status: 200, body: "ok" },
    [DEFAULT_VERSION_PATH]: { status: 404, body: "" },
  });

  await assert.rejects(
    smokeCheckImage(baseOptions({ expectVersion: "1.2.3" }), {
      docker,
      request,
      sleep: noSleep,
    }),
    /answered 404, expected 200/,
  );
});

test("the container is removed after a successful check", async () => {
  const docker = dockerStub();
  const request = requestStub({ "/": { status: 200, body: "ok" } });

  await smokeCheckImage(baseOptions(), { docker, request, sleep: noSleep });

  assert.deepEqual(docker.calls.at(-1), removeArgs(CONTAINER));
});

test("a removal that fails does not hide a successful check", async () => {
  const docker = dockerStub({
    rm: { status: 1, stdout: "", stderr: "No such container" },
  });
  const request = requestStub({ "/": { status: 200, body: "ok" } });
  const messages = [];

  const result = await smokeCheckImage(baseOptions(), {
    docker,
    request,
    sleep: noSleep,
    log: (message) => messages.push(message),
  });

  assert.equal(result.attempts, 1);
  assert.ok(messages.some((message) => message.includes("Could not remove")));
});

test("a port that is not published fails the check", async () => {
  const docker = dockerStub({ port: { ...ok, stdout: "\n" } });
  const request = requestStub({ "/": { status: 200, body: "ok" } });

  await assert.rejects(
    smokeCheckImage(baseOptions(), { docker, request, sleep: noSleep }),
    /Could not read a published port/,
  );
  assert.ok(docker.commands().includes("rm"));
});

test("the published address comes from the first line that holds a port", () => {
  assert.equal(
    parsePublishedBaseUrl("127.0.0.1:49154\n"),
    "http://127.0.0.1:49154",
  );
  assert.equal(
    parsePublishedBaseUrl("\n127.0.0.1:32768\n[::1]:32768\n"),
    "http://127.0.0.1:32768",
  );
  assert.throws(() => parsePublishedBaseUrl(""), /Could not read a published port/);
});

test("each docker command names the container that the check made", () => {
  assert.deepEqual(pullArgs(IMAGE), ["pull", IMAGE]);
  assert.deepEqual(portArgs({ containerName: CONTAINER, port: 80 }), [
    "port",
    CONTAINER,
    "80/tcp",
  ]);
  assert.deepEqual(logsArgs(CONTAINER), ["logs", "--tail", "50", CONTAINER]);
  assert.deepEqual(removeArgs(CONTAINER), [
    "rm",
    "--force",
    "--volumes",
    CONTAINER,
  ]);
  assert.deepEqual(
    runArgs({ image: IMAGE, containerName: CONTAINER, port: 80 }),
    [
      "run",
      "--detach",
      "--name",
      CONTAINER,
      "--publish",
      "127.0.0.1::80/tcp",
      IMAGE,
    ],
  );
});

test("the options are checked before the check starts a container", () => {
  assert.throws(() => normalizeOptions({ port: 80 }), /image is required/);
  assert.throws(
    () => normalizeOptions({ image: IMAGE, port: "http" }),
    /positive integer for port/,
  );
  assert.throws(
    () => normalizeOptions({ image: IMAGE, port: 70000 }),
    /port is out of range/,
  );
  assert.throws(
    () => normalizeOptions({ image: IMAGE, port: 80, probePath: "readyz" }),
    /probePath must start with a slash/,
  );
  assert.throws(
    () => normalizeOptions({ image: IMAGE, port: 80, attempts: 0 }),
    /positive integer for attempts/,
  );
  assert.throws(
    () => normalizeOptions({ image: IMAGE, port: 80, command: "start" }),
    /command must be an array/,
  );
});

test("the options keep the defaults that the release workflow relies on", () => {
  const plan = normalizeOptions({ image: IMAGE, port: 80 });

  assert.equal(plan.probePath, "/");
  assert.equal(plan.versionPath, DEFAULT_VERSION_PATH);
  assert.equal(plan.attempts, 30);
  assert.equal(plan.pullAttempts, 5);
  assert.equal(plan.delayMs, 2000);
  assert.equal(plan.expectVersion, "");
  assert.match(plan.containerName, /^chatto-smoke-[0-9a-f-]{36}$/);
});

test("the command line reads each option, and refuses an unknown one", () => {
  assert.deepEqual(
    parseArgs([
      "--image",
      IMAGE,
      "--port",
      "80",
      "--probe-path",
      "/",
      "--expect-version",
      "1.2.3",
      "--arg",
      "start",
      "--arg",
      "-c",
      "--arg",
      "/config/chatto.toml",
    ]),
    {
      command: ["start", "-c", "/config/chatto.toml"],
      image: IMAGE,
      port: "80",
      probePath: "/",
      expectVersion: "1.2.3",
    },
  );

  assert.throws(() => parseArgs([]), /--image is required/);
  assert.throws(() => parseArgs(["--image", IMAGE]), /--port is required/);
  assert.throws(() => parseArgs(["--image"]), /--image needs a value/);
  assert.throws(
    () => parseArgs(["--image", IMAGE, "--port", "80", "--wait"]),
    /Unknown option: --wait/,
  );
});

test("the command exits with a failure when the pull fails", () => {
  // The command runs the real `docker` binary, with a reference that Docker
  // refuses before it opens a connection. This proves the exit path only:
  // the command writes the reason and exits with a status that makes a
  // workflow step red. A registry is not available to an agent session, and
  // the first real pull happens at the next release.
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          modulePath,
          "--image",
          "ghcr.io/chattocorp/chatto-client:not a tag",
          "--port",
          "80",
          "--pull-attempts",
          "1",
          "--delay-ms",
          "0",
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /Could not pull .* in 1 attempts/);
      return true;
    },
  );
});

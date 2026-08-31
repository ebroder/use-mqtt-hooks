import { execa } from "execa";
import getPort from "get-port";
import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    mqttUrl: string;
  }
}

// Homebrew puts mosquitto in sbin, which is often missing from a non-login
// shell's PATH.
const ExtraBinDirs = ["/opt/homebrew/sbin", "/usr/local/sbin", "/usr/sbin"];

const StartupTimeout = 10_000;

const findMosquitto = async () => {
  const override = process.env["MOSQUITTO_BIN"];
  if (override) {
    try {
      await access(override, constants.X_OK);
    } catch {
      throw new Error(
        `MOSQUITTO_BIN is set to ${override}, which is not executable.`,
      );
    }
    return override;
  }

  const dirs = [
    ...(process.env["PATH"] ?? "").split(delimiter),
    ...ExtraBinDirs,
  ];
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }

    const candidate = join(dir, "mosquitto");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }

  throw new Error(
    "Could not find a mosquitto binary. Install it (brew install mosquitto, " +
      "or apt-get install mosquitto) or point MOSQUITTO_BIN at one.",
  );
};

const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });

const waitForPort = async (port: number) => {
  const deadline = Date.now() + StartupTimeout;
  while (!(await canConnect(port))) {
    if (Date.now() > deadline) {
      return false;
    }
    await setTimeout(50);
  }
  return true;
};

export default async function setup(project: TestProject) {
  const binary = await findMosquitto();
  const port = await getPort({ host: "127.0.0.1" });
  const configDir = await mkdtemp(join(tmpdir(), "use-mqtt-hooks-"));
  const configPath = join(configDir, "mosquitto.conf");

  await writeFile(
    configPath,
    [
      `listener ${port} 127.0.0.1`,
      "protocol websockets",
      "allow_anonymous true",
      "persistence false",
      "",
    ].join("\n"),
  );

  const broker = execa(binary, ["-c", configPath], {
    all: true,
    reject: false,
    // always reap the broker
    cleanup: true,
    forceKillAfterDelay: 2000,
  });

  const started = await Promise.race([waitForPort(port), broker]);
  if (started !== true) {
    broker.kill();
    const result = started === false ? await broker : started;
    const reason =
      started === false
        ? `did not start within ${StartupTimeout}ms`
        : "exited before it was ready";
    throw new Error(`mosquitto ${reason}:\n${result.all}`);
  }

  project.provide("mqttUrl", `ws://127.0.0.1:${port}`);

  return async () => {
    broker.kill();
    await broker;
    await rm(configDir, { recursive: true, force: true });
  };
}

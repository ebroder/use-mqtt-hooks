import { setTimeout } from "node:timers/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { MqttSubTracker } from "../src/MqttSubTracker.js";
import { asMqttClient, FakeMqttClient } from "./fakeClient.js";

let fake: FakeMqttClient;
let tracker: MqttSubTracker;

beforeEach(() => {
  fake = new FakeMqttClient();
  tracker = new MqttSubTracker(asMqttClient(fake));
});

// Unsubscription is deferred for a tick
const settle = () => setTimeout(0);

it("dedups subscriptions", () => {
  tracker.subscribe("a/b", vi.fn());
  tracker.subscribe("a/b", vi.fn());

  expect(fake.subscribeLog).toEqual(["a/b"]);
});

it("dispatches to every callback whose pattern matches", () => {
  const exact = vi.fn();
  const singleWildcard = vi.fn();
  const multiWildcard = vi.fn();
  const unrelated = vi.fn();

  tracker.subscribe("a/b/c", exact);
  tracker.subscribe("a/+/c", singleWildcard);
  tracker.subscribe("a/#", multiWildcard);
  tracker.subscribe("z/#", unrelated);

  fake.emitMessage("a/b/c", "hello");

  for (const callback of [exact, singleWildcard, multiWildcard]) {
    expect(callback).toHaveBeenCalledWith("a/b/c", Buffer.from("hello"));
  }
  expect(unrelated).not.toHaveBeenCalled();
});

it("keeps the subscription until the last callback goes away", async () => {
  const first = vi.fn();
  const second = vi.fn();
  tracker.subscribe("a/b", first);
  tracker.subscribe("a/b", second);

  tracker.unsubscribe("a/b", first);
  await settle();
  expect(fake.unsubscribeLog).toEqual([]);

  tracker.unsubscribe("a/b", second);
  await settle();
  expect(fake.unsubscribeLog).toEqual(["a/b"]);
});

it("does not unsubscribe when a resubscribe lands in the same tick", async () => {
  const leaving = vi.fn();
  tracker.subscribe("a/b", leaving);
  tracker.unsubscribe("a/b", leaving);
  tracker.subscribe("a/b", vi.fn());

  await settle();

  expect(fake.unsubscribeLog).toEqual([]);
  expect(fake.subscribeLog).toEqual(["a/b"]);
});

it("replays retained messages to a callback that subscribes later", () => {
  tracker.subscribe("devices/+key/status", vi.fn());
  fake.emitMessage("devices/one/status", "online", { retain: true });

  const late = vi.fn();
  tracker.subscribe("devices/+key/status", late);

  expect(late).toHaveBeenCalledWith(
    "devices/one/status",
    Buffer.from("online"),
  );
});

it("resubscribes topics whose subscribe was lost across a reconnect", () => {
  fake.holdAcknowledgements();
  tracker.subscribe("a/b", vi.fn());
  expect(fake.subscribeLog).toEqual(["a/b"]);

  fake.emitConnect();

  expect(fake.subscribeLog).toEqual(["a/b", "a/b"]);
});

it("clears retained messages the broker does not re-deliver on reconnect", async () => {
  vi.useFakeTimers();
  try {
    const callback = vi.fn();
    tracker.subscribe("devices/+key/status", callback);
    fake.emitMessage("devices/one/status", "online", { retain: true });
    callback.mockClear();

    fake.emitConnect();
    await vi.advanceTimersByTimeAsync(500);

    expect(callback).toHaveBeenCalledWith("devices/one/status", "");
    expect(tracker.retained.has("devices/one/status")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps retained messages the broker does re-deliver on reconnect", async () => {
  vi.useFakeTimers();
  try {
    const callback = vi.fn();
    tracker.subscribe("devices/+key/status", callback);
    fake.emitMessage("devices/one/status", "online", { retain: true });
    callback.mockClear();

    fake.emitConnect();
    fake.emitMessage("devices/one/status", "online", { retain: true });
    await vi.advanceTimersByTimeAsync(500);

    expect(callback).not.toHaveBeenCalledWith("devices/one/status", "");
    expect(tracker.retained.get("devices/one/status")).toEqual(
      Buffer.from("online"),
    );
  } finally {
    vi.useRealTimers();
  }
});

it("forgets retained messages once nothing subscribes to them", async () => {
  const callback = vi.fn();
  tracker.subscribe("devices/+key/status", callback);
  fake.emitMessage("devices/one/status", "online", { retain: true });
  expect(tracker.retained.size).toBe(1);

  tracker.unsubscribe("devices/+key/status", callback);
  await settle();

  expect(tracker.retained.size).toBe(0);
});

it("keeps dispatching after a callback throws", () => {
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  const throwing = vi.fn(() => {
    throw new Error("boom");
  });
  const healthy = vi.fn();

  tracker.subscribe("a/b", throwing);
  tracker.subscribe("a/b", healthy);
  fake.emitMessage("a/b", "hello");

  expect(healthy).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalled();
  consoleError.mockRestore();
});

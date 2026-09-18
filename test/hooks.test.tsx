// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import mqtt, { type MqttClient } from "mqtt";
import { afterEach, expect, inject, it } from "vitest";
import {
  MqttProvider,
  useMqtt,
  useMqttKv,
  useMqttListener,
  useMqttSet,
} from "../src/index.js";

const mqttUrl = inject("mqttUrl");

const observers: MqttClient[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(observers.splice(0).map((client) => client.endAsync(true)));
});

const connectObserver = async () => {
  const client = await mqtt.connectAsync(mqttUrl, { protocolVersion: 5 });
  observers.push(client);
  return client;
};

const Status = () => {
  const { status } = useMqtt();
  return <span data-testid="status">{status}</span>;
};

const waitForConnection = () =>
  waitFor(() => {
    expect(screen.getByTestId("status").textContent).toBe("connected");
  });

const withProvider = (children: React.ReactNode) => (
  <MqttProvider mqttUrl={mqttUrl} clientPrefix="test">
    {children}
  </MqttProvider>
);

it("reports the connection status", async () => {
  render(withProvider(<Status />));

  await waitForConnection();
});

it("stays disconnected without a URL", () => {
  render(
    <MqttProvider clientPrefix="test">
      <Status />
    </MqttProvider>,
  );

  expect(screen.getByTestId("status").textContent).toBe("disconnected");
});

it("delivers a published message back to a listener", async () => {
  const received: string[] = [];
  const Roundtrip = () => {
    const { publish } = useMqtt();
    useMqttListener("roundtrip/message", (_topic, message) => {
      received.push(message.toString());
    });
    return (
      <>
        <Status />
        <button
          data-testid="send"
          onClick={() => {
            void publish?.("roundtrip/message", "hello");
          }}
        >
          send
        </button>
      </>
    );
  };

  render(withProvider(<Roundtrip />));
  await waitForConnection();

  fireEvent.click(screen.getByTestId("send"));

  await waitFor(() => {
    expect(received).toEqual(["hello"]);
  });
});

it("delivers a retained message published before mount", async () => {
  const observer = await connectObserver();
  await observer.publishAsync("retained/message", "stored", {
    qos: 1,
    retain: true,
  });

  const received: string[] = [];
  const Listener = () => {
    useMqttListener("retained/message", (_topic, message) => {
      received.push(message.toString());
    });
    return <Status />;
  };

  render(withProvider(<Listener />));

  await waitFor(() => {
    expect(received).toEqual(["stored"]);
  });
});

it("subscribes to nothing while the topic is undefined", async () => {
  const observer = await connectObserver();
  await observer.publishAsync("optional/message", "stored", {
    qos: 1,
    retain: true,
  });

  const received: string[] = [];
  const Listener = ({ topic }: { topic?: string }) => {
    useMqttListener(topic, (_topic, message) => {
      received.push(message.toString());
    });
    return <Status />;
  };

  const { rerender } = render(withProvider(<Listener />));
  await waitForConnection();
  expect(received).toEqual([]);

  rerender(withProvider(<Listener topic="optional/message" />));

  await waitFor(() => {
    expect(received).toEqual(["stored"]);
  });
});

it("projects a wildcard subscription into a map", async () => {
  const observer = await connectObserver();
  await observer.publishAsync("kv/one/status", "online", {
    qos: 1,
    retain: true,
  });
  await observer.publishAsync("kv/two/status", "offline", {
    qos: 1,
    retain: true,
  });

  const Devices = () => {
    const devices = useMqttKv("kv/+key/status");
    return (
      <span data-testid="devices">
        {[...devices]
          .map(([key, value]) => `${key}=${value}`)
          .sort()
          .join(",")}
      </span>
    );
  };

  render(withProvider(<Devices />));
  await waitFor(() => {
    expect(screen.getByTestId("devices").textContent).toBe(
      "one=online,two=offline",
    );
  });

  await observer.publishAsync("kv/one/status", "", { qos: 1, retain: true });

  await waitFor(() => {
    expect(screen.getByTestId("devices").textContent).toBe("two=offline");
  });
});

it("runs map values through a transform", async () => {
  const observer = await connectObserver();
  await observer.publishAsync("transform/one/uptime", "12", {
    qos: 1,
    retain: true,
  });

  const Uptimes = () => {
    const uptimes = useMqttKv("transform/+key/uptime", Number);
    return (
      <span data-testid="uptimes">
        {[...uptimes].map(([key, value]) => `${key}=${value + 1}`).join(",")}
      </span>
    );
  };

  render(withProvider(<Uptimes />));

  await waitFor(() => {
    expect(screen.getByTestId("uptimes").textContent).toBe("one=13");
  });
});

it("exposes just the keys as a set", async () => {
  const observer = await connectObserver();
  await observer.publishAsync("set/one/present", "yes", {
    qos: 1,
    retain: true,
  });
  await observer.publishAsync("set/two/present", "yes", {
    qos: 1,
    retain: true,
  });

  const Present = () => {
    const present = useMqttSet("set/+key/present");
    return <span data-testid="present">{[...present].sort().join(",")}</span>;
  };

  render(withProvider(<Present />));

  await waitFor(() => {
    expect(screen.getByTestId("present").textContent).toBe("one,two");
  });
});

it("publishes the will when the provider unmounts", async () => {
  const observer = await connectObserver();
  await observer.subscribeAsync("will/status", { qos: 1 });
  const willed = new Promise<string>((resolve) => {
    observer.on("message", (topic, payload) => {
      if (topic === "will/status") {
        resolve(payload.toString());
      }
    });
  });

  const { unmount } = render(
    <MqttProvider
      mqttUrl={mqttUrl}
      clientPrefix="test"
      will={{ topic: "will/status", payload: "gone" }}
    >
      <Status />
    </MqttProvider>,
  );
  await waitForConnection();

  unmount();

  await expect(willed).resolves.toBe("gone");
});

it("passes the keepalive through to the client", async () => {
  const Keepalive = () => {
    const { client } = useMqtt();
    return <span data-testid="keepalive">{client?.options.keepalive}</span>;
  };

  render(
    <MqttProvider mqttUrl={mqttUrl} clientPrefix="test" keepalive={10}>
      <Keepalive />
    </MqttProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("keepalive").textContent).toBe("10");
  });
});

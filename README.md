# use-mqtt-hooks

[![CI](https://github.com/ebroder/use-mqtt-hooks/actions/workflows/ci.yml/badge.svg)](https://github.com/ebroder/use-mqtt-hooks/actions/workflows/ci.yml)

Hooks for interfacing with [MQTT.js][mqttjs] using React idioms:

- Shared connection management as a React context provider
- Subscriptions that match component lifecycle and can be multiplexed across
  components
- Helpers for aggregating retained messages across a prefix

## Install

```sh
npm install use-mqtt-hooks
```

The subscription machinery uses [`useEffectEvent`][useeffectevent], so React
19.2 or newer is required. Browsers can't speak the native MQTT protocol, so the
broker also needs websocket support enabled. (For Mosquitto, that's a `listener`
block with `protocol websockets`)

## Quick start

Add `MqttProvider` in your component tree above anything that talks to MQTT.
That connects to the MQTT broker and exposes the connection via React context:

```tsx
import { MqttProvider } from "use-mqtt-hooks";

createRoot(document.getElementById("root")!).render(
  <MqttProvider mqttUrl="ws://localhost:8080" clientPrefix="dashboard">
    <App />
  </MqttProvider>,
);
```

Below that, subscribe and publish from any component.

```tsx
import { useMqtt, useMqttListener } from "use-mqtt-hooks";

function Thermostat() {
  const { status, publish } = useMqtt();
  const [temperature, setTemperature] = useState<string>();

  useMqttListener("home/thermostat/temperature", (topic, message) => {
    setTemperature(message.toString());
  });

  return (
    <>
      <p>{status === "connected" ? (temperature ?? "--") : "offline"}</p>
      <button onClick={() => publish?.("home/thermostat/setpoint", "21")}>
        Set to 21
      </button>
    </>
  );
}
```

## API

### `<MqttProvider>`

| Prop           | Type                                       | Notes                                                    |
| -------------- | ------------------------------------------ | -------------------------------------------------------- |
| `mqttUrl`      | `string \| undefined`                      | Pass `undefined` to disconnect                           |
| `clientPrefix` | `string`                                   | Used to generate a random Client ID (computed per-mount) |
| `will`         | `{ topic, payload, retain? } \| undefined` | Last Will and Testament, published at QoS 1              |

`mqttUrl` can be unpopulated if either the broker address is not available
immediately at mount, or if you want to trigger a disconnection. All hooks
degrade quietly when not connected.

The MQTT protocol only allows specifying a will at connection time, so `will` is
only evaluated when the connection opens; changing the prop while the connection
is open won't take effect unless the connection bounces. The client always
disconnects un-gracefully, so both clean and unclean shutdowns will publish the
will.

Connections are MQTT v5 with RAP (Retain As Published) enabled, and everything
the provider sends uses QoS 1.

### `useMqtt()`

The basic hook for accessing MQTT. Returns an object containing:

- `status`: `"disconnected"`, `"connecting"`, or `"connected"`
- `publish(topic, message, options?)`: publishes at QoS 1, returns a Promise
  which resolves once the broker acknowledges the message. Pass
  `{ retain: true }` to set the retain flag. `publish` is `undefined` until the
  client is created (but will still be present while reconnecting).
- `client`: the underlying MQTT.js client, in case you need to do something this
  library doesn't support.

### `useMqttListener(topic, callback)`

Subscribes to a topic and calls `callback(topic, message)` as messages arrive.
The topic may contain MQTT wildcards (`+` or `#`), and may be an array to
subscribe to several at once.

Pass `undefined` to disable the subscription. (This allows for conditionally
subscribing to a topic without violating the [rules of hooks][].)

The callback does not need to be memoized. It is wrapped in `useEffectEvent`, so
it always sees the latest props and state without churning the subscription.

A message with an empty payload means the retained value on that topic was
cleared.

### `useMqttKv(pattern, transform?)`

Projects a wildcard subscription into a `ReadonlyMap`. The pattern must contain
exactly one named wildcard, `+key` (enforced in the type declaration):

```tsx
// Map<string, string> keyed by device ID
const devices = useMqttKv("devices/+key/status");

// Map<string, number>
const uptimes = useMqttKv("devices/+key/uptime", Number);
```

Keys are the observed values of `+key` and values are the payloads published
there, run through `transform` if you supply one. Clearing a retained topic
removes its key from the map. As with `useMqttListener`, `undefined` disables
the subscription.

### `useMqttSet(pattern)`

The same thing when only the keys matter, returning a `ReadonlySet<string>` of
the `+key` values seen.

## How it works

Most of the effort in this library is in `MqttSubTracker`, which exists to (a)
bridge the semantics of MQTT subscriptions and React component lifecycle
semantics and (b) allow multiple components to subscribe to the same topic. That
class manages:

**Reference counting.** Brokers don't reference count subscriptions from a
single client, so if two different components subscribed naively, the
subscription would get torn down when the first one unsubscribed. Instead, we
count subscriber components to each topic pattern, subscribe once, and dispatch
incoming messages to every callback whose pattern matches (wildcards included).

**Retained message replay.** Normally when a client subscribes to a topic with
retained messages, those messages get delivered immediately. But since the
client may already be subscribed to that topic, that wouldn't naively happen. We
track all retained messages (using MQTT v5's RAP flag) and re-deliver them when
a new component subscribes to a topic that we already have referenced.

**Deferred unsubscription.** When a component re-renders, its old cleanup logic
runs before the new setup logic. Naively, that would cause us to unsubscribe and
resubscribe to topics on every render, creating churn and the potential for
missing messages. Instead, unsubscribing is deferred by a tick so that the new
subscription has time to establish its reference.

**Reconnect repair.** When reconnecting, there is some subtlety in handling
retained messages correctly without transiently dropping state.

Collectively, these make it possible to use MQTT in a manner consistent with
React's hook idioms.

## Development

```sh
npm run lint    # tsc, eslint, and prettier in parallel
npm test        # vitest
npm run build   # emit dist/
```

Run `npm run lint` rather than the individual `lint:*` scripts.

The hook tests run against a real Mosquitto, which the suite starts on an
ephemeral port and shuts down afterwards. Install it (`brew install mosquitto`
or `apt-get install mosquitto`), or point `MOSQUITTO_BIN` at a binary somewhere
else.

## Acknowledgments

Development of this library was sponsored by [Strange Bird Immersive][], who
also agreed to release it as open source. Thanks to them for both.

## License

MIT

[mqttjs]: https://github.com/mqttjs/MQTT.js
[useeffectevent]: https://react.dev/reference/react/useEffectEvent
[Strange Bird Immersive]: https://strangebirdimmersive.com/
[rules of hooks]: https://react.dev/reference/rules/rules-of-hooks

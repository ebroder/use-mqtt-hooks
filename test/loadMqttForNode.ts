// MQTT.js detects the jsdom environment as a browser, but the browser
// implementation doesn't actually work, so disable the DOM while we load mqtt
// to force it to use the Node implementation instead.
const { window } = globalThis;
Reflect.deleteProperty(globalThis, "window");
await import("mqtt");
globalThis.window = window;

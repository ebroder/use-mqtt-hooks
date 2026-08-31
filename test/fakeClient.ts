import type { MqttClient } from "mqtt";
import { EventEmitter } from "node:events";

type AckCallback = (error: Error | null) => void;

// A stand-in for MqttClient covering the three things needed for
// MqttSubTracker: event registration, subscribe, and unsubscribe.
// Acknowledgements can be held back to simulate a subscription that's in flight
// when the connection drops.
export class FakeMqttClient extends EventEmitter {
  readonly subscribeLog: string[] = [];
  readonly unsubscribeLog: string[] = [];

  private holding = false;
  private held: (() => void)[] = [];

  subscribe(topic: string, _options: unknown, callback: AckCallback) {
    this.subscribeLog.push(topic);
    this.acknowledge(() => {
      callback(null);
    });
    return this;
  }

  unsubscribe(topic: string, callback: AckCallback) {
    this.unsubscribeLog.push(topic);
    this.acknowledge(() => {
      callback(null);
    });
    return this;
  }

  holdAcknowledgements() {
    this.holding = true;
  }

  releaseAcknowledgements() {
    this.holding = false;
    const pending = this.held;
    this.held = [];
    for (const acknowledge of pending) {
      acknowledge();
    }
  }

  emitMessage(topic: string, payload: string, { retain = false } = {}) {
    this.emit("message", topic, Buffer.from(payload), { retain });
  }

  emitConnect() {
    this.emit("connect");
  }

  private acknowledge(run: () => void) {
    if (this.holding) {
      this.held.push(run);
    } else {
      run();
    }
  }
}

export const asMqttClient = (fake: FakeMqttClient) =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  fake as unknown as MqttClient;

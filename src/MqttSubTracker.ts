import type { MqttClient } from "mqtt";
import { matches } from "mqtt-pattern";

export type MqttCallback = (topic: string, message: Buffer | "") => void;

// Assume that this is the maximum gap between redelivering two retained
// messages after reconnecting to the broker. (After this long, any message we
// knew about before disconnecting is assumed to have been cleared)
const RetainedResyncDelay = 500;

// Reference-count MQTT subscriptions and handle dispatch across duplicate
// subscriptions, including re-delivering retained messages for new subscribers.
//
// This is definitely over-engineered, but MQTT doesn't natively handle this
// subscription deduplication or dispatch (especially with wildcards), and I'd
// rather have it than accidentally end up with bugs from not having it.
export class MqttSubTracker {
  public subscribers = new Map<string, Set<MqttCallback>>();
  public subscribed = new Set<string>();

  public retained = new Map<string, Buffer>();
  public client: MqttClient;

  private unconfirmedRetained: Set<string> | undefined;
  private resyncTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(client: MqttClient) {
    this.client = client;
    this.client.on("message", (topic, message, packet) => {
      if (packet.retain) {
        // If we are waiting for retained messages to be re-delivered and this
        // is one of them, remove it from the wait list and re-set the cleanup
        // timer.
        const unconfirmed = this.unconfirmedRetained;
        if (unconfirmed?.delete(topic)) {
          this.scheduleRetainedCleanup(unconfirmed);
        }

        if (message.length === 0) {
          this.retained.delete(topic);
        } else {
          this.retained.set(topic, message);
        }
      }

      this.dispatch(topic, message);
    });
    this.client.on("connect", () => {
      // Check for topics that have callbacks but aren't subscribed - can happen
      // if a subscribe is dropped around a reconnect.
      for (const topic of this.subscribers.keys()) {
        this.checkSubStatus(topic);
      }

      this.startRetainedResync();
    });
  }

  private dispatch(topic: string, message: Buffer | "") {
    for (const [sub, callbacks] of this.subscribers) {
      if (!matches(sub, topic)) {
        continue;
      }

      for (const callback of callbacks) {
        try {
          callback(topic, message);
        } catch (err: unknown) {
          console.error(
            `Error in MQTT message callback for topic "${topic}":`,
            err,
          );
        }
      }
    }
  }

  // If a retained message is deleted while we're disconnected, we never hear
  // about it. To avoid leaving the message in our cache, track retained
  // messages we knew about pre-disconnect and remove any that don't get
  // re-confirmed within an initial post-connection window.
  private startRetainedResync() {
    const unconfirmed = new Set(this.retained.keys());
    this.unconfirmedRetained = unconfirmed;
    this.scheduleRetainedCleanup(unconfirmed);
  }

  private scheduleRetainedCleanup(unconfirmed: Set<string>) {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.unconfirmedRetained = undefined;

      for (const topic of unconfirmed) {
        this.retained.delete(topic);
        this.dispatch(topic, "");
      }
    }, RetainedResyncDelay);
  }

  private garbageCollectRetained() {
    for (const topic of this.retained.keys()) {
      let hasSubscribers = false;
      for (const sub of this.subscribers.keys()) {
        if (matches(sub, topic)) {
          hasSubscribers = true;
          break;
        }
      }

      if (!hasSubscribers) {
        this.retained.delete(topic);
      }
    }
  }

  private checkSubStatus(topic: string) {
    const count = this.subscribers.get(topic)?.size ?? 0;
    const isSubscribed = this.subscribed.has(topic);

    if (count > 0 && !isSubscribed) {
      this.client.subscribe(topic, { qos: 1, rap: true }, (err) => {
        if (err) {
          console.error(`Failed to subscribe to topic "${topic}":`, err);
          return;
        }
        this.subscribed.add(topic);
        this.checkSubStatus(topic);
      });
    } else if (count === 0 && isSubscribed) {
      this.client.unsubscribe(topic, (err) => {
        if (err) {
          console.error(`Failed to unsubscribe from topic "${topic}":`, err);
        }
        // mqtt.js drops the topic from its resubscribe list when it builds the
        // UNSUBSCRIBE packet, so the subscription is gone after the next
        // reconnect whether or not the UNSUBACK arrived.
        this.subscribed.delete(topic);
        this.garbageCollectRetained();
        this.checkSubStatus(topic);
      });
    }
  }

  public subscribe(topic: string, callback: MqttCallback) {
    const callbacks = this.subscribers.get(topic) ?? new Set();
    this.subscribers.set(topic, callbacks);

    if (!callbacks.has(callback)) {
      for (const [retainedTopic, message] of this.retained) {
        if (matches(topic, retainedTopic)) {
          try {
            callback(retainedTopic, message);
          } catch (err: unknown) {
            console.error(
              `Error in MQTT retained message callback for topic "${topic}":`,
              err,
            );
          }
        }
      }
    }

    callbacks.add(callback);

    this.checkSubStatus(topic);
  }

  public unsubscribe(topic: string, callback: MqttCallback) {
    const callbacks = this.subscribers.get(topic);
    if (!callbacks?.has(callback)) {
      return;
    }

    callbacks.delete(callback);
    if (callbacks.size === 0) {
      this.subscribers.delete(topic);
    }

    // When unsubscribing, defer checking the subscription status. This allows
    // for transient unsub/resub effects (e.g. due to component re-renders) to
    // hopefully settle without triggering spurious unsub/resub loops.
    queueMicrotask(() => {
      this.checkSubStatus(topic);
    });
  }
}

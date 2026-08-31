import { useContext, useEffect, useEffectEvent } from "react";
import { MqttContext } from "./MqttContext.js";
import type { MqttCallback } from "./MqttSubTracker.js";

export const useMqttListener = (
  topic: string[] | string | undefined,
  callback: MqttCallback,
) => {
  // Get the internal-only context to access subTracker
  const { subTracker } = useContext(MqttContext);
  const onMessage = useEffectEvent(callback);

  useEffect(() => {
    if (!subTracker || !topic) {
      return;
    }

    const topics = Array.isArray(topic) ? topic : [topic];
    topics.forEach((t) => {
      subTracker.subscribe(t, onMessage);
    });
    return () => {
      topics.forEach((t) => {
        subTracker.unsubscribe(t, onMessage);
      });
    };
  }, [subTracker, topic]);
};

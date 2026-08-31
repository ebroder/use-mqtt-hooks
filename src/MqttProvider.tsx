import mqtt, { type IClientOptions } from "mqtt";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import {
  MqttContext,
  type MqttContextTypeInternal,
  type MqttPublishOptions,
  type MqttStatus,
} from "./MqttContext.js";
import { MqttSubTracker } from "./MqttSubTracker.js";

export const MqttProvider = ({
  mqttUrl,
  clientPrefix,
  will,
  children,
}: {
  mqttUrl?: string;
  clientPrefix: string;
  // MQTT only supports setting the will on connect, so this is only read at
  // connect time; changes to the prop aren't propagated until the next
  // connection. It's published either by a disconnect or when this component
  // unmounts.
  will?: {
    topic: string;
    payload: string | Buffer;
    retain?: boolean;
  };
  children: ReactNode;
}) => {
  const [clientRandom] = useState(() =>
    Math.random().toString(16).substring(2, 10),
  );
  const clientId = useMemo(
    () => `${clientPrefix}_${clientRandom}`,
    [clientPrefix, clientRandom],
  );

  const [context, setContext] = useState<MqttContextTypeInternal>({
    status: "disconnected",
  });
  const setStatus = (status: MqttStatus) => {
    setContext((prev) => {
      return { ...prev, status };
    });
  };

  const readWill = useEffectEvent(
    (): IClientOptions["will"] => will && { ...will, qos: 1 },
  );

  useEffect(() => {
    if (!mqttUrl) {
      return undefined;
    }

    const instance = mqtt.connect(mqttUrl, {
      clientId,
      protocolVersion: 5,
      will: readWill(),
    });
    const publish = async (
      topic: string,
      message: string | Buffer,
      options?: MqttPublishOptions,
    ) => {
      await instance.publishAsync(topic, message, { ...options, qos: 1 });
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setContext({
      client: instance,
      status: "connecting",
      subTracker: new MqttSubTracker(instance),
      publish,
    });

    const handleConnect = () => {
      setStatus("connected");
    };
    const handleReconnect = () => {
      setStatus("connecting");
    };
    const handleDisconnect = () => {
      setStatus("disconnected");
    };
    const handleError = (error: unknown) => {
      console.error("MQTT connection error", error);
    };

    instance.on("connect", handleConnect);
    instance.on("reconnect", handleReconnect);
    instance.on("close", handleDisconnect);
    instance.on("error", handleError);

    return () => {
      instance.off("connect", handleConnect);
      instance.off("reconnect", handleReconnect);
      instance.off("close", handleDisconnect);
      instance.off("error", handleError);
      instance.end(true);
      setContext({ status: "disconnected" });
    };
  }, [mqttUrl, clientId]);

  return <MqttContext value={context}>{children}</MqttContext>;
};

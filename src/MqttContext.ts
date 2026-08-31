import { type IClientPublishOptions, type MqttClient } from "mqtt";
import { createContext } from "react";
import type { MqttSubTracker } from "./MqttSubTracker.js";

export type MqttStatus = "disconnected" | "connecting" | "connected";

export type MqttPublishOptions = Pick<IClientPublishOptions, "retain">;

export interface MqttContextType {
  client?: MqttClient;
  status: MqttStatus;
  publish?: (
    topic: string,
    message: string | Buffer,
    options?: MqttPublishOptions,
  ) => Promise<void>;
}

export type MqttContextTypeInternal = MqttContextType & {
  subTracker?: MqttSubTracker;
};

export const MqttContext = createContext<MqttContextTypeInternal>({
  status: "disconnected",
});

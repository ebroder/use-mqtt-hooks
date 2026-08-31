import { useContext } from "react";
import { MqttContext, type MqttContextType } from "./MqttContext.js";

export const useMqtt = (): MqttContextType => useContext(MqttContext);

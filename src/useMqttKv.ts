import { clean, exec, type MqttParameters } from "mqtt-pattern";
import { useMemo, useState } from "react";
import { useMqttListener } from "./useMqttListener.js";

// Constraint: MqttParameters<Pattern> must be exactly { key: string }
type KeyOnlyPattern<P extends string> = [MqttParameters<P>] extends [
  { key: string },
]
  ? [{ key: string }] extends [MqttParameters<P>]
    ? P
    : "Pattern must have exactly one wildcard named +key"
  : "Pattern must have exactly one wildcard named +key";

const isKeyMatch = (match: unknown): match is { key: string } => {
  return (
    typeof match === "object" &&
    match !== null &&
    "key" in match &&
    typeof match.key === "string"
  );
};

export function useMqttKv<const Pattern extends string>(
  pattern: KeyOnlyPattern<Pattern> | undefined,
): ReadonlyMap<string, string>;
export function useMqttKv<const Pattern extends string, V>(
  pattern: KeyOnlyPattern<Pattern> | undefined,
  transform: (value: string) => V,
): ReadonlyMap<string, V>;
export function useMqttKv(
  pattern: string | undefined,
  transform?: (value: string) => unknown,
): ReadonlyMap<string, unknown> {
  const [data, setData] = useState<Map<string, unknown>>(new Map());
  useMqttListener(pattern ? clean(pattern) : undefined, (topic, message) => {
    if (!pattern) return;

    const match = exec(pattern, topic);
    if (!isKeyMatch(match)) {
      return;
    }

    const { key } = match;

    setData((prev) => {
      const newMap = new Map(prev);
      if (message.length === 0) {
        newMap.delete(key);
      } else {
        newMap.set(
          key,
          transform ? transform(message.toString()) : message.toString(),
        );
      }
      return newMap;
    });
  });

  return data;
}

export function useMqttSet<const Pattern extends string>(
  pattern: KeyOnlyPattern<Pattern> | undefined,
): ReadonlySet<string> {
  const kv = useMqttKv(pattern);
  return useMemo(() => new Set(kv.keys()), [kv]);
}

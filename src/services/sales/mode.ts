/** Only `shadow` analyzes. `live` is not implemented and behaves as off. */
export function salesEngineMode(raw = process.env["SALES_ENGINE_MODE"]): "off" | "shadow" {
  return raw?.trim().toLowerCase() === "shadow" ? "shadow" : "off";
}

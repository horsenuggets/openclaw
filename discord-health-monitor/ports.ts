import fs from "node:fs";
import path from "node:path";

export const PORT_FILENAME = ".port";

/** Read an instance's port from its `.port` dotfile. */
export function readInstancePort(instanceDir: string): number | undefined {
  const portPath = path.join(instanceDir, PORT_FILENAME);
  if (!fs.existsSync(portPath)) {
    return undefined;
  }
  try {
    const raw = fs.readFileSync(portPath, "utf-8").trim();
    if (!/^\d+$/.test(raw)) {
      return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

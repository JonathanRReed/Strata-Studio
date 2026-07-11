import type { ControlKey } from "../../engine/types.ts";

/** The control set the active style declares (or the full default set). */
export function buildControlSet(controlKeys: ControlKey[] | undefined): Set<ControlKey> {
  return new Set<ControlKey>(controlKeys ?? [
    "amplitude", "spacing", "lineWidth", "noise", "detail", "compression",
    "occlusion", "grain", "rotation", "label", "aspectRatio", "seed", "palette",
    "buildingInfluence", "roadInfluence", "waterInfluence",
    "oceanInfluence", "lakeInfluence", "riverInfluence",
  ]);
}

import { heroProjection } from "./hero";
import { impactProjection } from "./impact";
import { type Projection, registerProjection } from "./index";
import { partyProjection } from "./party";
import { questProjection } from "./quest";
import { sagaProjection } from "./saga";
import { sessionKindProjection } from "./session-kind";
import { stintProjection } from "./stint";
import { windowProjection } from "./window";

/** Every production projection, in registration order. */
export const ALL_PROJECTIONS: readonly Projection[] = [
  heroProjection,
  impactProjection,
  partyProjection,
  sagaProjection,
  questProjection,
  stintProjection,
  windowProjection,
  sessionKindProjection,
];

let registered = false;

export function registerAllProjections(): void {
  if (registered) return;
  for (const projection of ALL_PROJECTIONS) registerProjection(projection);
  registered = true;
}

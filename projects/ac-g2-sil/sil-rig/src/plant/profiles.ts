/**
 * PV and load shape generators.
 *
 * Profiles are pure functions of time-of-day plus a seeded Rng, so a profile
 * never breaks reproducibility.
 */
import type { Rng } from '../core/rng.js';

export interface ProfileContext {
  /** Fractional hour of local day, 0..24. */
  hour: number;
  /** Nameplate array size in W, used to scale PV profiles. */
  capacityW: number;
  /** 0..1 knob for how erratic weather-driven profiles are. */
  variability: number;
  /** Local day-of-year, so multi-day profiles can vary between days. */
  dayOfYear: number;
  rng: Rng;
}

export type ProfileFn = (ctx: ProfileContext) => number;

const SUNRISE = 6.5;
const SUNSET = 19.5;

/** Bell curve across daylight hours, peaking solar noon at ~85% of nameplate. */
function clearSky(hour: number, capacityW: number): number {
  if (hour <= SUNRISE || hour >= SUNSET) return 0;
  const span = SUNSET - SUNRISE;
  const phase = ((hour - SUNRISE) / span) * Math.PI;
  return Math.max(0, Math.sin(phase)) * capacityW * 0.85;
}

export const PV_PROFILES: Record<string, ProfileFn> = {
  // `custom` leaves plant.pv_w exactly as the operator set it.
  flat: ({ capacityW }) => capacityW * 0.5,

  night: () => 0,

  clear_day: ({ hour, capacityW }) => clearSky(hour, capacityW),

  sunrise_sunset: ({ hour, capacityW }) => clearSky(hour, capacityW),

  // Slow-moving cloud cover: smooth multiplicative attenuation.
  cloudy: ({ hour, capacityW, rng }) => {
    const base = clearSky(hour, capacityW);
    const cloud = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(hour * 1.7));
    return base * cloud * rng.float(0.9, 1.1);
  },

  // Fast partial-cloud edge effects: the case that makes UIs thrash.
  intermittent: ({ hour, capacityW, rng, variability }) => {
    const base = clearSky(hour, capacityW);
    const chancePct = Math.round(30 + 50 * variability);
    return rng.chance(chancePct) ? base * rng.float(0.05, 0.3) : base * rng.float(0.85, 1.0);
  },

  // Heavy uniform cloud: roughly a fifth of clear-sky yield, all day.
  overcast: ({ hour, capacityW, rng }) => clearSky(hour, capacityW) * rng.float(0.15, 0.25),

  // A week of alternating weather, so multi-day soak runs are not monotonous.
  mixed_week: ({ hour, capacityW, rng, dayOfYear }) => {
    const base = clearSky(hour, capacityW);
    const factor = [1.0, 0.9, 0.35, 0.2, 0.65, 1.0, 0.8][dayOfYear % 7] ?? 1;
    return base * factor * rng.float(0.95, 1.05);
  },
};

export const LOAD_PROFILES: Record<string, ProfileFn> = {
  flat: () => 1000,

  residential_day: ({ hour }) => {
    // Overnight base, morning bump, midday dip, evening peak.
    if (hour < 6) return 450;
    if (hour < 9) return 1800;
    if (hour < 16) return 900;
    if (hour < 21) return 3200;
    return 1200;
  },

  evening_peak: ({ hour }) => (hour >= 17 && hour < 21 ? 6500 : 800),

  ev_charging: ({ hour }) => (hour >= 22 || hour < 6 ? 7400 : 900),

  spiky: ({ rng }) => (rng.chance(15) ? rng.float(6000, 11_000) : rng.float(400, 1200)),
};

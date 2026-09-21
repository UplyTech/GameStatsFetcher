import { describe, expect, it } from "vitest";
import {
  asArray,
  bool,
  clamp,
  emptyParticipantStats,
  int,
  kd,
  matchResult,
  modeStats,
  num,
  participantStats,
  permille,
  pick,
  playerStats,
  str,
  sum,
  toMinorUnits,
  ts,
  winRate,
} from "../src/normalize.js";
import type { PlayerRef } from "../src/types.js";

const REF: PlayerRef = {
  titleId: "cs2",
  providerId: "steam",
  id: "76561197960287930",
  displayName: "gaben",
  platform: "steam",
  region: null,
};

describe("absent versus zero", () => {
  it("keeps them apart, which is the whole point of the model", () => {
    expect(num(0)).toBe(0);
    expect(num(undefined)).toBeNull();
    expect(num(null)).toBeNull();
    expect(num("")).toBeNull();
  });

  it("never returns NaN", () => {
    expect(num("abc")).toBeNull();
    expect(num({})).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("coerces numeric strings and booleans", () => {
    expect(num("42")).toBe(42);
    expect(num("3.5")).toBe(3.5);
    expect(num(true)).toBe(1);
    expect(num(false)).toBe(0);
  });
});

describe("int", () => {
  it("truncates rather than rounds", () => {
    expect(int(3.9)).toBe(3);
    expect(int(-3.9)).toBe(-3);
    expect(int("7.2")).toBe(7);
    expect(int(undefined)).toBeNull();
  });
});

describe("str", () => {
  it("trims and treats blank as absent", () => {
    expect(str("  hello  ")).toBe("hello");
    expect(str("   ")).toBeNull();
    expect(str(null)).toBeNull();
    expect(str(42)).toBe("42");
  });
});

describe("bool", () => {
  it("accepts the several ways an API says yes", () => {
    expect(bool(true)).toBe(true);
    expect(bool("true")).toBe(true);
    expect(bool(1)).toBe(true);
    expect(bool("1")).toBe(true);
    expect(bool(false)).toBe(false);
    expect(bool("0")).toBe(false);
    expect(bool("maybe")).toBeNull();
    expect(bool(undefined)).toBeNull();
  });
});

describe("timestamps", () => {
  it("passes milliseconds through", () => {
    expect(ts(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("promotes seconds to milliseconds", () => {
    expect(ts(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("parses ISO strings", () => {
    expect(ts("2024-01-01T00:00:00.000Z")).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
  });

  it("parses numeric strings with the same seconds rule", () => {
    expect(ts("1700000000")).toBe(1_700_000_000_000);
  });

  it("rejects zero, negatives and nonsense", () => {
    expect(ts(0)).toBeNull();
    expect(ts(-5)).toBeNull();
    expect(ts("not a date")).toBeNull();
    expect(ts(undefined)).toBeNull();
  });
});

describe("permille arithmetic", () => {
  it("computes a ratio as an integer", () => {
    expect(permille(1, 2)).toBe(500);
    expect(permille(1, 3)).toBe(333);
    expect(permille(2, 3)).toBe(667);
  });

  it("refuses to divide by zero or by an unknown", () => {
    expect(permille(1, 0)).toBeNull();
    expect(permille(null, 10)).toBeNull();
    expect(permille(10, null)).toBeNull();
  });

  it("includes draws in the win rate denominator", () => {
    // 5 wins, 4 losses, 1 draw is 50 %, not 55.6 %.
    expect(winRate(5, 4, 1)).toBe(500);
    expect(winRate(5, 5)).toBe(500);
  });

  it("returns null for a player who has played nothing", () => {
    expect(winRate(0, 0)).toBeNull();
    expect(winRate(null, 5)).toBeNull();
  });

  it("treats zero deaths as one, matching every in-game scoreboard", () => {
    expect(kd(10, 0)).toBe(10_000);
    expect(kd(10, 5)).toBe(2_000);
    expect(kd(3, 4)).toBe(750);
    expect(kd(null, 4)).toBeNull();
  });
});

describe("clamp", () => {
  it("bounds a caller-supplied limit", () => {
    expect(clamp(5, 1, 100)).toBe(5);
    expect(clamp(0, 1, 100)).toBe(1);
    expect(clamp(1_000, 1, 100)).toBe(100);
  });
});

describe("matchResult", () => {
  it("maps the several ways an API reports an outcome", () => {
    expect(matchResult(true)).toBe("win");
    expect(matchResult(false)).toBe("loss");
    expect(matchResult("true")).toBe("win");
    expect(matchResult(true, true)).toBe("draw");
    expect(matchResult(undefined)).toBe("unknown");
  });
});

describe("participant stats", () => {
  it("starts with everything absent", () => {
    const empty = emptyParticipantStats();
    expect(empty.kills).toBeNull();
    expect(empty.extra).toEqual({});
  });

  it("fills only what was given", () => {
    const stats = participantStats({ kills: 10, extra: { headshots: 4 } });
    expect(stats.kills).toBe(10);
    expect(stats.deaths).toBeNull();
    expect(stats.extra.headshots).toBe(4);
  });
});

describe("modeStats", () => {
  it("derives matches played and win rate from wins and losses", () => {
    const mode = modeStats({ id: "solo", wins: 6, losses: 4 });
    expect(mode.matchesPlayed).toBe(10);
    expect(mode.winRatePermille).toBe(600);
    expect(mode.label).toBe("solo");
  });

  it("leaves derived fields null when the inputs are absent", () => {
    const mode = modeStats({ id: "solo" });
    expect(mode.matchesPlayed).toBeNull();
    expect(mode.winRatePermille).toBeNull();
  });
});

describe("playerStats", () => {
  it("derives totals and ratios once, so every provider agrees", () => {
    const stats = playerStats({
      ref: REF,
      wins: 30,
      losses: 20,
      kills: 100,
      deaths: 50,
      raw: {},
    });
    expect(stats.matchesPlayed).toBe(50);
    expect(stats.winRatePermille).toBe(600);
    expect(stats.kdPermille).toBe(2_000);
  });

  it("does not invent a total when only one side is known", () => {
    const stats = playerStats({ ref: REF, wins: 30, raw: {} });
    expect(stats.matchesPlayed).toBeNull();
    expect(stats.winRatePermille).toBe(1_000);
  });

  it("keeps the raw payload attached", () => {
    const raw = { anything: true };
    expect(playerStats({ ref: REF, raw }).raw).toBe(raw);
  });
});

describe("pick and asArray", () => {
  it("reads a nested path without throwing on a missing branch", () => {
    const source = { data: [{ stats: { kills: 7 } }] };
    expect(pick(source, "data", 0, "stats", "kills")).toBe(7);
    expect(pick(source, "data", 5, "stats")).toBeUndefined();
    expect(pick(source, "nope", "deeper")).toBeUndefined();
    expect(pick(null, "a")).toBeUndefined();
  });

  it("wraps a single item and drops an absent one", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray(1)).toEqual([1]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray(null)).toEqual([]);
  });
});

describe("sum", () => {
  it("ignores absent values but reports null when all were absent", () => {
    expect(sum([1, null, 2, undefined])).toBe(3);
    expect(sum([null, undefined])).toBeNull();
    expect(sum([])).toBeNull();
    expect(sum([0])).toBe(0);
  });
});

describe("toMinorUnits", () => {
  it("converts an amount into integer minor units", () => {
    expect(toMinorUnits(12.34)).toBe(1_234);
    expect(toMinorUnits(1_000_000)).toBe(100_000_000);
    expect(toMinorUnits(null)).toBeNull();
  });
});

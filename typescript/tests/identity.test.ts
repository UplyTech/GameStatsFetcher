import { describe, expect, it } from "vitest";
import {
  dashUuid,
  encodeSupercellTag,
  expandRiotQuery,
  formatRiotId,
  isSteamId64,
  normaliseSupercellTag,
  parseRiotId,
  pickIdentifier,
  toBattleTagPath,
  toSteamAccountId,
  toSteamId2,
  toSteamId3,
  toSteamId64,
  undashUuid,
} from "../src/identity.js";
import { ValidationError } from "../src/errors.js";

// Gabe Newell's account, which is the one Steam id everybody can check.
const GABEN_64 = "76561197960287930";
const GABEN_32 = "22202";

describe("Steam identifiers", () => {
  it("recognises a SteamID64", () => {
    expect(isSteamId64(GABEN_64)).toBe(true);
    expect(isSteamId64("22202")).toBe(false);
    expect(isSteamId64("7656119796028793")).toBe(false);
  });

  it("passes a SteamID64 through unchanged", () => {
    expect(toSteamId64(GABEN_64)).toBe(GABEN_64);
  });

  it("converts SteamID3 to SteamID64", () => {
    expect(toSteamId64(`[U:1:${GABEN_32}]`)).toBe(GABEN_64);
    expect(toSteamId64(`U:1:${GABEN_32}`)).toBe(GABEN_64);
  });

  it("converts SteamID2 to SteamID64", () => {
    expect(toSteamId64("STEAM_0:0:11101")).toBe(GABEN_64);
  });

  it("converts a bare 32-bit account id", () => {
    expect(toSteamId64(GABEN_32)).toBe(GABEN_64);
    expect(toSteamId64(Number(GABEN_32))).toBe(GABEN_64);
  });

  it("round-trips through every rendering", () => {
    expect(toSteamAccountId(GABEN_64)).toBe(GABEN_32);
    expect(toSteamId3(GABEN_64)).toBe(`[U:1:${GABEN_32}]`);
    expect(toSteamId2(GABEN_64)).toBe("STEAM_0:0:11101");
    expect(toSteamId64(toSteamId2(GABEN_64))).toBe(GABEN_64);
    expect(toSteamId64(toSteamId3(GABEN_64))).toBe(GABEN_64);
  });

  it("rejects a truncated SteamID64 rather than treating it as an account id", () => {
    // This is the failure mode of storing a SteamID64 in a JS number: it loses
    // precision and would otherwise silently convert into a different person.
    expect(() => toSteamId64("7656119796028793000")).toThrow(ValidationError);
  });

  it("rejects nonsense", () => {
    expect(() => toSteamId64("gaben")).toThrow(ValidationError);
    expect(() => toSteamId64("")).toThrow(ValidationError);
  });
});

describe("Riot identifiers", () => {
  it("splits Name#Tag", () => {
    expect(parseRiotId("Faker#KR1")).toEqual({ gameName: "Faker", tagLine: "KR1" });
  });

  it("splits on the last hash, because a game name may contain one", () => {
    expect(parseRiotId("no#1 fan#EUW")).toEqual({ gameName: "no#1 fan", tagLine: "EUW" });
  });

  it("rejects a missing or empty tag", () => {
    expect(() => parseRiotId("Faker")).toThrow(ValidationError);
    expect(() => parseRiotId("Faker#")).toThrow(ValidationError);
    expect(() => parseRiotId("#KR1")).toThrow(ValidationError);
  });

  it("formats back to the input", () => {
    expect(formatRiotId(parseRiotId("Faker#KR1"))).toBe("Faker#KR1");
  });

  it("expands a Riot ID pasted into the name field", () => {
    expect(expandRiotQuery({ name: "Faker#KR1" })).toMatchObject({
      gameName: "Faker",
      tagLine: "KR1",
    });
  });

  it("leaves an already-split query alone", () => {
    const query = { gameName: "Faker", tagLine: "KR1" };
    expect(expandRiotQuery(query)).toBe(query);
  });

  it("leaves a plain name alone", () => {
    expect(expandRiotQuery({ name: "Faker" })).toEqual({ name: "Faker" });
  });
});

describe("BattleTags", () => {
  it("swaps the hash for a dash", () => {
    expect(toBattleTagPath("Player#1234")).toBe("Player-1234");
    expect(toBattleTagPath("Player-1234")).toBe("Player-1234");
  });

  it("rejects a tag with no discriminator", () => {
    expect(() => toBattleTagPath("Player")).toThrow(ValidationError);
  });
});

describe("Supercell tags", () => {
  it("normalises case, the leading hash and the letter O", () => {
    // Supercell tags never contain the letter O, so one in a user-supplied tag
    // is always a mistyped zero.
    expect(normaliseSupercellTag("2ppOjcvl")).toBe("#2PP0JCVL");
    expect(normaliseSupercellTag("#2PP0JCVL")).toBe("#2PP0JCVL");
  });

  it("url-encodes the hash", () => {
    expect(encodeSupercellTag("#2PP")).toBe("%232PP");
  });

  it("rejects characters Supercell does not use", () => {
    expect(() => normaliseSupercellTag("#ABC")).toThrow(ValidationError);
    expect(() => normaliseSupercellTag("")).toThrow(ValidationError);
  });
});

describe("Minecraft UUIDs", () => {
  const undashed = "069a79f444e94726a5befca90e38aaf5";
  const dashed = "069a79f4-44e9-4726-a5be-fca90e38aaf5";

  it("adds and removes dashes", () => {
    expect(dashUuid(undashed)).toBe(dashed);
    expect(undashUuid(dashed)).toBe(undashed);
    expect(dashUuid(dashed)).toBe(dashed);
  });

  it("rejects a non-UUID", () => {
    expect(() => dashUuid("nope")).toThrow(ValidationError);
  });
});

describe("pickIdentifier", () => {
  it("takes the first accepted field that is present", () => {
    expect(pickIdentifier({ name: "x", steamId: "1" }, ["steamId", "name"])).toEqual({
      key: "steamId",
      value: "1",
    });
    expect(pickIdentifier({ name: "x" }, ["steamId", "name"])).toEqual({
      key: "name",
      value: "x",
    });
  });

  it("treats blank and whitespace as absent", () => {
    expect(pickIdentifier({ name: "   " }, ["name"])).toBeNull();
    expect(pickIdentifier({}, ["name"])).toBeNull();
  });

  it("ignores object-valued fields such as extra", () => {
    expect(pickIdentifier({ extra: { a: 1 } }, ["extra"])).toBeNull();
  });
});

/**
 * Identifier plumbing.
 *
 * The same human being is a SteamID64 to Valve, a 32-bit account id to
 * OpenDota, a `Name#Tag` to Riot, a `Name-1234` to the Overwatch career pages
 * and a `#2PP0JCVL` to Supercell. Every one of those conversions is somewhere
 * a bug can hide, so they live here with tests rather than inline in twelve
 * provider modules.
 */

import { STEAM_ID64_BASE } from "./constants.js";
import { ValidationError } from "./errors.js";
import type { PlayerQuery } from "./types.js";

/** A SteamID64 is 17 digits and starts at the base offset. */
const STEAM_ID64_PATTERN = /^7656119[0-9]{10}$/;
const STEAM_ID3_PATTERN = /^\[?U:1:([0-9]+)\]?$/;
const STEAM_ID2_PATTERN = /^STEAM_[0-5]:([01]):([0-9]+)$/;

/** True for a well-formed SteamID64. */
export function isSteamId64(value: string): boolean {
  return STEAM_ID64_PATTERN.test(value);
}

/**
 * Turn any Steam identifier into a SteamID64.
 *
 * Accepts SteamID64, SteamID3 (`[U:1:123]`), SteamID2 (`STEAM_0:1:61`) and a
 * bare 32-bit account id. Does *not* accept a vanity URL - that needs a network
 * call, which belongs in the Steam provider and not in a pure function.
 */
export function toSteamId64(value: string | number): string {
  const raw = String(value).trim();
  if (isSteamId64(raw)) return raw;

  const id3 = STEAM_ID3_PATTERN.exec(raw);
  if (id3?.[1]) return (BigInt(id3[1]) + STEAM_ID64_BASE).toString();

  const id2 = STEAM_ID2_PATTERN.exec(raw);
  if (id2?.[1] !== undefined && id2[2] !== undefined) {
    const account = BigInt(id2[2]) * 2n + BigInt(id2[1]);
    return (account + STEAM_ID64_BASE).toString();
  }

  // A bare 32-bit account id. Bounded above so a truncated SteamID64 - the
  // failure mode of somebody storing one in a JS number - is rejected rather
  // than silently converted into a different person's id.
  if (/^[0-9]{1,10}$/.test(raw)) {
    const account = BigInt(raw);
    if (account > 0n && account < 4_294_967_296n) {
      return (account + STEAM_ID64_BASE).toString();
    }
  }

  throw new ValidationError(`"${raw}" is not a recognisable Steam identifier`);
}

/**
 * The 32-bit account id, as a string.
 *
 * OpenDota, Ballchasing, Deadlock and logs.tf all key on this rather than on
 * the 64-bit form.
 */
export function toSteamAccountId(value: string | number): string {
  const id64 = toSteamId64(value);
  return (BigInt(id64) - STEAM_ID64_BASE).toString();
}

/** The legacy `STEAM_0:Y:Z` rendering, which some tournament tools still use. */
export function toSteamId2(value: string | number): string {
  const account = BigInt(toSteamAccountId(value));
  return `STEAM_0:${account % 2n}:${account / 2n}`;
}

/** The `[U:1:N]` rendering used by Source engine server logs. */
export function toSteamId3(value: string | number): string {
  return `[U:1:${toSteamAccountId(value)}]`;
}

/** A Riot ID split into its two halves. */
export interface RiotId {
  readonly gameName: string;
  readonly tagLine: string;
}

/**
 * Parse `Name#Tag`.
 *
 * Splits on the *last* hash: game names may contain one, tag lines may not.
 * Getting this backwards breaks exactly the accounts whose owners chose an
 * awkward name, which is a bug that survives a long time in testing.
 */
export function parseRiotId(value: string): RiotId {
  const raw = value.trim();
  const hash = raw.lastIndexOf("#");
  if (hash <= 0 || hash === raw.length - 1) {
    throw new ValidationError(`"${value}" is not a Riot ID - expected the form Name#Tag`);
  }
  return {
    gameName: raw.slice(0, hash),
    tagLine: raw.slice(hash + 1),
  };
}

/** Render a Riot ID back into `Name#Tag`. */
export function formatRiotId(id: RiotId): string {
  return `${id.gameName}#${id.tagLine}`;
}

/**
 * Battle.net BattleTag as the web APIs want it.
 *
 * Blizzard's own endpoints take `Name-1234`, and the Overwatch career pages
 * that OverFast scrapes use the same form. Only the separator differs from what
 * the user types, so this is the conversion that gets forgotten.
 */
export function toBattleTagPath(value: string): string {
  const raw = value.trim();
  if (!/^[^#-]+[#-][0-9]+$/.test(raw)) {
    throw new ValidationError(`"${value}" is not a BattleTag - expected the form Name#1234`);
  }
  return raw.replace("#", "-");
}

/**
 * Supercell player tag, normalised.
 *
 * Supercell tags are upper case, always carry a leading hash in their canonical
 * form, and use `O` nowhere - the character is always a zero. Users copy tags
 * out of screenshots, so the letter/digit confusion is a real and frequent
 * failure rather than a theoretical one.
 */
export function normaliseSupercellTag(value: string): string {
  const raw = value.trim().toUpperCase().replace(/^#/, "").replace(/O/g, "0");
  if (!/^[0289PYLQGRJCUV]{3,12}$/.test(raw)) {
    throw new ValidationError(
      `"${value}" is not a Supercell player tag - they use only the characters 0289PYLQGRJCUV`,
    );
  }
  return `#${raw}`;
}

/** The same tag, URL-encoded for a path segment (`%23ABC`). */
export function encodeSupercellTag(value: string): string {
  return encodeURIComponent(normaliseSupercellTag(value));
}

/** Minecraft UUIDs come back from Mojang undashed and are needed dashed. */
export function dashUuid(value: string): string {
  const raw = value.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(raw)) {
    throw new ValidationError(`"${value}" is not a 32-character UUID`);
  }
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join("-");
}

/** The undashed form Hypixel expects. */
export function undashUuid(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

/**
 * The first identifier a query supplies from a title's accepted list.
 *
 * Titles list their identifiers best-first, so this implements "use the most
 * reliable thing the caller gave us" without each title reimplementing it.
 */
export function pickIdentifier(
  query: PlayerQuery,
  accepted: readonly (keyof PlayerQuery)[],
): { key: keyof PlayerQuery; value: string } | null {
  for (const key of accepted) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "object") continue;
    const text = String(value).trim();
    if (text.length > 0) return { key, value: text };
  }
  return null;
}

/**
 * Accept `Name#Tag` in the `name` field and split it into the Riot fields.
 *
 * Users paste their whole Riot ID into one box far more often than they fill
 * two, and refusing that would be pedantry rather than validation.
 */
export function expandRiotQuery(query: PlayerQuery): PlayerQuery {
  if (query.gameName && query.tagLine) return query;
  if (query.name?.includes("#")) {
    const parsed = parseRiotId(query.name);
    return { ...query, gameName: parsed.gameName, tagLine: parsed.tagLine };
  }
  return query;
}

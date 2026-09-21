/**
 * Jagex's RuneScape hiscores.
 *
 * Two games on one host, distinguished only by a path prefix: `m=hiscore` is
 * RuneScape (the "RS3" line) and `m=hiscore_oldschool` is Old School RuneScape.
 * Both have published the same lite endpoint for two decades, which makes this
 * one of the most stable player APIs anywhere — and the reason it is worth
 * having despite neither game running an esports circuit. A player asking
 * "what is my rank" gets a real answer.
 *
 * # What the hiscores are, and what they are not
 *
 * A hiscore entry is a **rank, a level and an experience total per skill**,
 * plus a rank and a score per tracked activity (clue scrolls, boss kill counts,
 * league points). There is no match history, no profile, no last-seen: the
 * hiscores are a ladder, and the registry says so rather than implying more.
 *
 * # No key, and no scraping
 *
 * The lite endpoint is public and unauthenticated. The *ranked* pages
 * (`overall.ws?table=0&page=1`) are HTML and are therefore out of scope — this
 * package does not scrape, so there is no `getLeaderboard` here even though a
 * leaderboard visibly exists on the website. Claiming one would mean parsing a
 * page Jagex never promised to keep stable.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError, ParseError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** Which of the two games a call is about. */
export type RuneScapeGame = "osrs" | "rs3";

/** The path segment Jagex uses for each game. */
const GAME_PREFIX: Readonly<Record<RuneScapeGame, string>> = {
  osrs: "m=hiscore_oldschool",
  rs3: "m=hiscore",
};

/** One skill as the hiscores report it. */
export interface HiscoreSkill {
  readonly id: number;
  readonly name: string;
  readonly rank: number | null;
  readonly level: number | null;
  readonly xp: number | null;
}

/** One tracked activity: a boss, a clue tier, a league. */
export interface HiscoreActivity {
  readonly id: number;
  readonly name: string;
  readonly rank: number | null;
  readonly score: number | null;
}

/** A whole hiscores entry. */
export interface HiscoreEntry {
  readonly skills: readonly HiscoreSkill[];
  readonly activities: readonly HiscoreActivity[];
}

/**
 * The skill order of the CSV form, which carries no names.
 *
 * Only used by the fallback below. The order is fixed by Jagex and has only
 * ever been appended to — a new skill arrives at the end, which is why reading
 * this table positionally is safe and why a name that is not in it comes back
 * as `Skill 30` rather than as a guess.
 */
const CSV_SKILLS: readonly string[] = [
  "Overall",
  "Attack",
  "Defence",
  "Strength",
  "Hitpoints",
  "Ranged",
  "Prayer",
  "Magic",
  "Cooking",
  "Woodcutting",
  "Fletching",
  "Fishing",
  "Firemaking",
  "Crafting",
  "Smithing",
  "Mining",
  "Herblore",
  "Agility",
  "Thieving",
  "Slayer",
  "Farming",
  "Runecraft",
  "Hunter",
  "Construction",
];

/** `-1` is the hiscores' spelling of "unranked". Never report it as a rank. */
function ranked(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

export class JagexProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("jagex", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /**
   * A player's hiscores entry.
   *
   * Asks for the JSON form first, because it carries the skill and activity
   * names inline: when Jagex adds a skill — and they do — a name-carrying
   * response stays correct while a positional one silently shifts every column
   * after it. The CSV form is the fallback, and the only reason it exists here
   * is that it is the form that has been stable the longest.
   */
  public async getHiscores(game: RuneScapeGame, name: string): Promise<HiscoreEntry> {
    const titleId = game === "osrs" ? "old-school-runescape" : "runescape";
    return this.cached(
      ["hiscores", game, name.toLowerCase()],
      "getRank",
      titleId,
      TTL.rank ?? 60,
      async () => {
        const prefix = GAME_PREFIX[game];
        const query = { player: name };

        const json = await this.get<
          { skills?: unknown[]; activities?: unknown[] } | string | null
        >(`/${prefix}/index_lite.json`, { query, nullOn404: true });

        if (json && typeof json === "object" && Array.isArray(json.skills)) {
          return this.fromJson(json as { skills: unknown[]; activities?: unknown[] });
        }

        const csv = await this.get<string | null>(`/${prefix}/index_lite.ws`, {
          query,
          nullOn404: true,
          parse: "text",
        });
        if (typeof csv !== "string" || csv.trim().length === 0) {
          throw new NotFoundError(this.id, `RuneScape player "${name}"`, titleId);
        }
        return this.fromCsv(csv);
      },
    );
  }

  /** The JSON form: names come from the upstream, so nothing is positional. */
  private fromJson(payload: { skills: unknown[]; activities?: unknown[] }): HiscoreEntry {
    const skills = payload.skills.map((raw, index) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        id: typeof row.id === "number" ? row.id : index,
        name: typeof row.name === "string" ? row.name : `Skill ${index}`,
        rank: ranked(row.rank),
        level: ranked(row.level),
        xp: ranked(row.xp),
      };
    });
    const activities = (payload.activities ?? []).map((raw, index) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      return {
        id: typeof row.id === "number" ? row.id : index,
        name: typeof row.name === "string" ? row.name : `Activity ${index}`,
        rank: ranked(row.rank),
        score: ranked(row.score),
      };
    });
    return { skills, activities };
  }

  /**
   * The CSV form: `rank,level,xp` per skill, then `rank,score` per activity.
   *
   * The boundary between the two is where the rows stop having three columns,
   * which is how the format has always been read. Activities are numbered
   * rather than named because the CSV carries no names and inventing them from
   * a table that Jagex reorders would be worse than admitting the gap.
   */
  private fromCsv(csv: string): HiscoreEntry {
    const rows = csv
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(",").map((cell) => cell.trim()))
      .filter((cells) => cells.length >= 2);

    const skills: HiscoreSkill[] = [];
    const activities: HiscoreActivity[] = [];

    rows.forEach((cells, index) => {
      if (cells.length >= 3 && skills.length === index) {
        skills.push({
          id: index,
          name: CSV_SKILLS[index] ?? `Skill ${index}`,
          rank: ranked(cells[0]),
          level: ranked(cells[1]),
          xp: ranked(cells[2]),
        });
        return;
      }
      const position = activities.length;
      activities.push({
        id: position,
        name: `Activity ${position}`,
        rank: ranked(cells[0]),
        score: ranked(cells[1]),
      });
    });

    if (skills.length === 0) {
      throw new ParseError(this.id, "the hiscores returned no skill rows");
    }
    return { skills, activities };
  }
}

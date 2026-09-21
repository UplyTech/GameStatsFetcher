/**
 * CCP's EVE Swagger Interface (ESI).
 *
 * EVE has no ladder and no matchmaking, and it is still one of the best player
 * APIs in this package: a character's public record — name, corporation,
 * alliance, security status, birthday — is served without a key, and so are the
 * corporation and alliance behind it. Everything private (assets, wallet, mail)
 * needs that character's own OAuth token and is deliberately out of scope here.
 *
 * # Names are not identifiers
 *
 * ESI is keyed on numeric character ids. A name is turned into one through
 * `/universe/ids/`, which is a POST that takes a list and answers with matches
 * across every category at once — so the lookup filters to `characters` and
 * refuses a name that matched only a corporation.
 *
 * Names are also **not unique over time**: a character can be renamed, and the
 * id is what survives. Callers who store anything should store the id, which is
 * why `resolvePlayer` returns it and why the profile carries it rather than the
 * name it was looked up by.
 *
 * # Security status is a rank, and the only one there is
 *
 * The closest EVE has to a rating. It runs from -10 to +5, it is public, and it
 * is reported as-is in permille rather than rounded, because -4.9 and -5.0 are
 * different things to a gate camp.
 */

import { ProviderClient } from "./base.js";
import type { RequestSpec } from "../http.js";
import { NotFoundError } from "../errors.js";
import { TTL } from "../constants.js";
import type { Runtime } from "../runtime.js";

/** A character's public record. */
export interface EveCharacter {
  readonly id: number;
  readonly name: string;
  readonly corporationId: number | null;
  readonly allianceId: number | null;
  readonly birthday: string | null;
  readonly securityStatus: number | null;
  readonly raceId: number | null;
  readonly description: string | null;
}

/** A corporation or alliance, as much of it as is public. */
export interface EveOrganisation {
  readonly id: number;
  readonly name: string;
  readonly ticker: string | null;
  readonly memberCount: number | null;
  readonly founded: string | null;
}

export class EveProvider extends ProviderClient {
  constructor(runtime: Runtime) {
    super("eve-esi", runtime);
  }

  protected override async authorize(spec: RequestSpec): Promise<RequestSpec> {
    return spec;
  }

  /**
   * A character name to its id.
   *
   * `/universe/ids/` answers across every category, so a name that exists only
   * as a corporation comes back with an empty `characters` list — which is a
   * missing *character*, not a missing name, and is reported as such.
   */
  public async resolveCharacter(name: string): Promise<{ id: number; name: string }> {
    return this.cached(
      ["character-id", name.toLowerCase()],
      "resolvePlayer",
      "eve-online",
      TTL.resolvePlayer ?? 86_400,
      async () => {
        const found = await this.post<{
          characters?: { id?: number; name?: string }[];
        } | null>("/universe/ids/", [name], { query: { datasource: "tranquility" } });

        const match = found?.characters?.find(
          (entry) => typeof entry?.id === "number" && entry.id > 0,
        );
        if (!match?.id) {
          throw new NotFoundError(this.id, `EVE character "${name}"`, "eve-online");
        }
        return { id: match.id, name: match.name ?? name };
      },
    );
  }

  /** The public half of a character record. */
  public async getCharacter(id: number): Promise<EveCharacter> {
    return this.cached(
      ["character", id],
      "getPlayer",
      "eve-online",
      TTL.player ?? 300,
      async () => {
        const row = await this.get<Record<string, unknown> | null>(`/characters/${id}/`, {
          query: { datasource: "tranquility" },
          nullOn404: true,
        });
        if (!row) {
          throw new NotFoundError(this.id, `EVE character ${id}`, "eve-online");
        }
        return {
          id,
          name: typeof row.name === "string" ? row.name : String(id),
          corporationId: typeof row.corporation_id === "number" ? row.corporation_id : null,
          allianceId: typeof row.alliance_id === "number" ? row.alliance_id : null,
          birthday: typeof row.birthday === "string" ? row.birthday : null,
          securityStatus:
            typeof row.security_status === "number" ? row.security_status : null,
          raceId: typeof row.race_id === "number" ? row.race_id : null,
          description: typeof row.description === "string" ? row.description : null,
        };
      },
    );
  }

  /** A corporation, as much of it as is public. */
  public async getCorporation(id: number): Promise<EveOrganisation | null> {
    return this.cached(
      ["corporation", id],
      "getPlayer",
      "eve-online",
      TTL.metadata ?? 3_600,
      async () => {
        const row = await this.get<Record<string, unknown> | null>(`/corporations/${id}/`, {
          query: { datasource: "tranquility" },
          nullOn404: true,
        });
        if (!row) return null;
        return {
          id,
          name: typeof row.name === "string" ? row.name : String(id),
          ticker: typeof row.ticker === "string" ? row.ticker : null,
          memberCount: typeof row.member_count === "number" ? row.member_count : null,
          founded: typeof row.date_founded === "string" ? row.date_founded : null,
        };
      },
    );
  }

  /** An alliance. Same shape as a corporation; EVE reports fewer fields. */
  public async getAlliance(id: number): Promise<EveOrganisation | null> {
    return this.cached(
      ["alliance", id],
      "getPlayer",
      "eve-online",
      TTL.metadata ?? 3_600,
      async () => {
        const row = await this.get<Record<string, unknown> | null>(`/alliances/${id}/`, {
          query: { datasource: "tranquility" },
          nullOn404: true,
        });
        if (!row) return null;
        return {
          id,
          name: typeof row.name === "string" ? row.name : String(id),
          ticker: typeof row.ticker === "string" ? row.ticker : null,
          memberCount: null,
          founded: typeof row.date_founded === "string" ? row.date_founded : null,
        };
      },
    );
  }

  /**
   * The server's own status: players online, and which build they are on.
   *
   * The one endpoint here that is about the world rather than a player, and the
   * reason `getMetadata` is a declared capability for this title.
   */
  public async getServerStatus(): Promise<Record<string, unknown>> {
    return this.cached(
      ["status"],
      "getMetadata",
      "eve-online",
      60,
      async () => {
        const row = await this.get<Record<string, unknown> | null>("/status/", {
          query: { datasource: "tranquility" },
          nullOn404: true,
        });
        return row ?? {};
      },
    );
  }
}

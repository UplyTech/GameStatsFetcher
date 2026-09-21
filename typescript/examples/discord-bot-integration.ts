/**
 * A `/stats <game> <player>` command that works for every registered title.
 *
 * The Discord parts are stand-ins so this file runs without discord.js, but the
 * shape is the real one - and the four things worth copying are:
 *
 * 1. **One client for the process.** It owns the cache and the rate limiters;
 *    constructing one per command spends every quota twice.
 * 2. **Autocomplete from the registry**, so a user cannot pick a title the bot
 *    cannot serve.
 * 3. **`supports()` before the call**, so the reply says "Tekken 8 has no
 *    ranked ladder" instead of showing an empty embed.
 * 4. **Typed errors mapped to sentences a user can act on.** "Your profile is
 *    private" and "that player does not exist" are different problems, and the
 *    error classes keep them apart.
 */

import {
  GameStatsClient,
  LocalRateLimitError,
  MissingCredentialError,
  NotFoundError,
  PrivateProfileError,
  RateLimitError,
  UnsupportedCapabilityError,
  type PlayerQuery,
  type RankInfo,
  type TitleDescriptor,
} from "../src/index.js";

// One per process. Not one per command, and not one per guild.
const client = new GameStatsClient({
  apiKeys: {
    steam: process.env.STEAM_API_KEY,
    riot: process.env.RIOT_API_KEY,
    faceit: process.env.FACEIT_API_KEY,
    pandascore: process.env.PANDASCORE_TOKEN,
  },
  cache: {
    // Redis so every shard of the bot shares one warm cache. Without it each
    // shard would spend the same quota on the same player.
    driver: process.env.REDIS_HOST ? "redis" : "memory",
    redis: { host: process.env.REDIS_HOST ?? "", port: 6379 },
    keyPrefix: "bot:gsf:",
  },
  userAgent: "MyDiscordBot/2.1 (+https://example.com/bot)",
  logger: "warn",
});

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

/**
 * Only offer titles this deployment can actually serve.
 *
 * A user picking a title whose key is not configured gets a confusing failure;
 * filtering here means the option never appears.
 */
export function autocompleteTitles(typed: string): { name: string; value: string }[] {
  const usable = new Set(client.usableTitles().map((title) => title.id));
  return client
    .search(typed, 25)
    .filter((title) => usable.has(title.id))
    .map((title) => ({ name: title.name, value: title.id }));
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

interface Interaction {
  options: { getString(name: string): string | null };
  deferReply(): Promise<void>;
  editReply(payload: { content?: string; embeds?: unknown[] }): Promise<void>;
}

export async function handleStatsCommand(interaction: Interaction): Promise<void> {
  const titleId = interaction.options.getString("game") ?? "";
  const player = interaction.options.getString("player") ?? "";
  const region = interaction.options.getString("region") ?? undefined;

  await interaction.deferReply();

  const descriptor = client.tryTitle(titleId)?.title;
  if (!descriptor) {
    await interaction.editReply({ content: `I do not know the game "${titleId}".` });
    return;
  }

  const title = client.title(descriptor.id);

  // Check before calling: the reply is more useful than a caught exception.
  if (!title.supports("getPlayerStats")) {
    await interaction.editReply({
      content: explainNoPlayerData(descriptor),
    });
    return;
  }

  try {
    const query = buildQuery(descriptor, player, region);
    const ref = await title.resolvePlayer(query);
    const stats = await title.getPlayerStats(ref);
    const ranks = title.supports("getRank") ? await title.getRank(ref) : [];

    await interaction.editReply({
      embeds: [
        {
          title: `${ref.displayName ?? player} - ${descriptor.name}`,
          fields: [
            { name: "Matches", value: format(stats.matchesPlayed), inline: true },
            { name: "Win rate", value: percent(stats.winRatePermille), inline: true },
            { name: "K/D", value: ratio(stats.kdPermille), inline: true },
            ...ranks.slice(0, 3).map((rank) => ({
              name: rank.queue,
              value: describeRank(rank),
              inline: true,
            })),
          ],
          footer: { text: `via ${ref.providerId}` },
        },
      ],
    });
  } catch (error) {
    await interaction.editReply({ content: toUserMessage(error, descriptor, player) });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Turn one free-text box into whatever the title accepts.
 *
 * Users paste a Riot ID, a Steam id, a Supercell tag or a plain name into the
 * same field. The registry says which of those the title can use, so every
 * plausible field is filled and the title picks.
 */
function buildQuery(title: TitleDescriptor, input: string, region?: string): PlayerQuery {
  const query: Record<string, unknown> = { name: input.trim() };
  if (region) query.region = region;

  if (title.identifiers.includes("steamId") && /^\d{17}$/.test(input)) query.steamId = input;
  if (title.identifiers.includes("playerTag")) query.playerTag = input;
  if (title.identifiers.includes("battleTag")) query.battleTag = input;
  if (title.identifiers.includes("puuid") && input.length > 70) query.puuid = input;
  // `gameName`/`tagLine` are filled by the package itself when `name` contains
  // a hash, so there is nothing to do for a Riot ID here.
  return query as PlayerQuery;
}

/** Say *why* a title has no player data, using the registry rather than a guess. */
function explainNoPlayerData(title: TitleDescriptor): string {
  const sources = title.providers.join(", ");
  return (
    `${title.name} has no public player API - its publisher does not offer one. ` +
    `What I can show is the professional circuit (${sources}). ` +
    `Try \`/esports ${title.id}\`.`
  );
}

function describeRank(rank: RankInfo): string {
  const parts = [rank.tier, rank.division].filter(Boolean).join(" ");
  const points = rank.tierPoints !== null ? ` (${rank.tierPoints})` : "";
  return parts.length > 0 ? `${parts}${points}` : (rank.rating?.toString() ?? "unranked");
}

function format(value: number | null): string {
  return value === null ? "-" : value.toLocaleString("en-GB");
}

function percent(permille: number | null): string {
  return permille === null ? "-" : `${(permille / 10).toFixed(1)} %`;
}

function ratio(permille: number | null): string {
  return permille === null ? "-" : (permille / 1_000).toFixed(2);
}

/**
 * One sentence a user can act on, per failure kind.
 *
 * This mapping is the reason the error hierarchy is as fine-grained as it is:
 * four of these are the user's problem, one is the operator's, and collapsing
 * them into "something went wrong" would make all five look like an outage.
 */
function toUserMessage(error: unknown, title: TitleDescriptor, player: string): string {
  if (error instanceof PrivateProfileError) {
    return `**${player}**'s profile is private. They can open it in the game's privacy settings.`;
  }
  if (error instanceof NotFoundError) {
    return `I could not find **${player}** in ${title.name}. Check the spelling and the region.`;
  }
  if (error instanceof UnsupportedCapabilityError) {
    return explainNoPlayerData(title);
  }
  if (error instanceof RateLimitError || error instanceof LocalRateLimitError) {
    const wait = "retryAfterMs" in error && error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1_000) : 30;
    return `I am being rate limited. Try again in about ${wait} seconds.`;
  }
  if (error instanceof MissingCredentialError) {
    // The operator's problem, not the user's - so it is logged in full and the
    // user gets a sentence that does not leak configuration detail.
    console.error("[bot] configuration problem:", error.message);
    return `${title.name} is not configured on this bot yet.`;
  }
  console.error("[bot] unexpected failure:", error);
  return "Something went wrong fetching those stats. It has been logged.";
}

// ---------------------------------------------------------------------------
// An esports command, which works for every one of the 83 titles
// ---------------------------------------------------------------------------

export async function handleEsportsCommand(interaction: Interaction): Promise<void> {
  const titleId = interaction.options.getString("game") ?? "";
  await interaction.deferReply();

  const title = client.tryTitle(titleId);
  if (!title) {
    await interaction.editReply({ content: `I do not know the game "${titleId}".` });
    return;
  }

  try {
    const matches = await title.getEsportsMatches({ status: "scheduled", limit: 5 });
    if (matches.length === 0) {
      await interaction.editReply({ content: `No upcoming ${title.title.name} matches.` });
      return;
    }

    const lines = matches.map((match) => {
      const teams = match.opponents.map((opponent) => opponent.name).join(" vs ");
      const when = match.scheduledAt ? `<t:${Math.floor(match.scheduledAt / 1_000)}:R>` : "TBD";
      return `**${teams}** - ${when}${match.tournament ? ` (${match.tournament.name})` : ""}`;
    });
    await interaction.editReply({ content: lines.join("\n") });
  } catch (error) {
    await interaction.editReply({ content: toUserMessage(error, title.title, "") });
  }
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

process.once("SIGTERM", async () => {
  await client.destroy();
  process.exit(0);
});

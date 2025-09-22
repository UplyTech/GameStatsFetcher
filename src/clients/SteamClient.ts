import { get } from "../utils/request";

export class SteamClient {
    constructor(private apiKey: string) { }

    /**
     * Get global achievements for a given game (by AppID).
     */
    async getGlobalAchievements(appId: number) {
        const url = `https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appId}`;
        return await get(url);
    }

    /**
     * Get schema of stats/achievements for a game (defines all possible stats).
     */
    async getSchemaForGame(appId: number) {
        const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key=${this.apiKey}&appid=${appId}`;
        return await get(url);
    }

    /**
     * Get user stats + achievements for a specific game and SteamID.
     */
    async getUserStatsForGame(appId: number, steamId: string) {
        const url = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=${appId}&key=${this.apiKey}&steamid=${steamId}`;
        return await get(url);
    }

    /**
     * Get user achievements for a specific game.
     */
    async getPlayerAchievements(appId: number, steamId: string) {
        const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?appid=${appId}&key=${this.apiKey}&steamid=${steamId}`;
        return await get(url);
    }

    /**
     * Get player summaries (basic profile data).
     */
    async getPlayerSummaries(steamIds: string[]) {
        const ids = steamIds.join(",");
        const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${this.apiKey}&steamids=${ids}`;
        return await get(url);
    }

    /**
     * Get owned games for a player.
     */
    async getOwnedGames(steamId: string) {
        const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${this.apiKey}&steamid=${steamId}&include_appinfo=true&include_played_free_games=true`;
        return await get(url);
    }

    /**
     * Get recently played games for a player.
     */
    async getRecentlyPlayedGames(steamId: string) {
        const url = `https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/?key=${this.apiKey}&steamid=${steamId}`;
        return await get(url);
    }

    /**
     * Resolve a vanity URL (custom profile name -> SteamID64).
     */
    async resolveVanityURL(vanityUrl: string) {
        const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${this.apiKey}&vanityurl=${vanityUrl}`;
        return await get(url);
    }

    /**
     * Get friends list of a player.
     */
    async getFriendList(steamId: string) {
        const url = `https://api.steampowered.com/ISteamUser/GetFriendList/v1/?key=${this.apiKey}&steamid=${steamId}`;
        return await get(url);
    }
}

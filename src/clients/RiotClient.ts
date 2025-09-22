import { get } from "../utils/request";

export class RiotClient {
    constructor(private apiKey: string) { }

    // -------------------------------
    // 🔹 Summoner (general profile)
    // -------------------------------
    async getSummonerByName(name: string, region: string) {
        const url = `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-name/${encodeURIComponent(
            name
        )}?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getSummonerByPUUID(puuid: string, region: string) {
        const url = `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getSummonerByAccountId(accountId: string, region: string) {
        const url = `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-account/${accountId}?api_key=${this.apiKey}`;
        return await get(url);
    }

    // -------------------------------
    // 🔹 League of Legends (LoL)
    // -------------------------------
    async getRankedStatsBySummonerId(summonerId: string, region: string) {
        const url = `https://${region}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summonerId}?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getMatchListByPUUID(puuid: string, regionRouting: string, count: number = 20) {
        const url = `https://${regionRouting}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}&api_key=${this.apiKey}`;
        return await get(url);
    }

    async getMatchById(matchId: string, regionRouting: string) {
        const url = `https://${regionRouting}.api.riotgames.com/lol/match/v5/matches/${matchId}?api_key=${this.apiKey}`;
        return await get(url);
    }

    // -------------------------------
    // 🔹 Teamfight Tactics (TFT)
    // -------------------------------
    async getTFTSummonerByName(name: string, region: string) {
        const url = `https://${region}.api.riotgames.com/tft/summoner/v1/summoners/by-name/${encodeURIComponent(
            name
        )}?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getTFTRankedStatsBySummonerId(summonerId: string, region: string) {
        const url = `https://${region}.api.riotgames.com/tft/league/v1/entries/by-summoner/${summonerId}?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getTFTMatchListByPUUID(puuid: string, regionRouting: string, count: number = 20) {
        const url = `https://${regionRouting}.api.riotgames.com/tft/match/v1/matches/by-puuid/${puuid}/ids?start=0&count=${count}&api_key=${this.apiKey}`;
        return await get(url);
    }

    async getTFTMatchById(matchId: string, regionRouting: string) {
        const url = `https://${regionRouting}.api.riotgames.com/tft/match/v1/matches/${matchId}?api_key=${this.apiKey}`;
        return await get(url);
    }

    // -------------------------------
    // 🔹 Valorant (VAL)
    // -------------------------------
    async getValorantContent(region: string) {
        const url = `https://${region}.api.riotgames.com/val/content/v1/contents?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getValorantMatchListByPUUID(puuid: string, regionRouting: string) {
        const url = `https://${regionRouting}.api.riotgames.com/val/match/v1/matchlists/by-puuid/${puuid}?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getValorantMatchById(matchId: string, regionRouting: string) {
        const url = `https://${regionRouting}.api.riotgames.com/val/match/v1/matches/${matchId}?api_key=${this.apiKey}`;
        return await get(url);
    }

    // -------------------------------
    // 🔹 Legends of Runeterra (LoR)
    // -------------------------------
    async getLoRSummonerByName(name: string, region: string) {
        const url = `https://${region}.api.riotgames.com/lor/ranked/v1/leaderboards?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getLoRMatchListByPUUID(puuid: string, regionRouting: string) {
        const url = `https://${regionRouting}.api.riotgames.com/lor/match/v1/matches/by-puuid/${puuid}/ids?api_key=${this.apiKey}`;
        return await get(url);
    }

    async getLoRMatchById(matchId: string, regionRouting: string) {
        const url = `https://${regionRouting}.api.riotgames.com/lor/match/v1/matches/${matchId}?api_key=${this.apiKey}`;
        return await get(url);
    }
}

import { SteamClient } from "./clients/SteamClient";
import { RiotClient } from "./clients/RiotClient";
import { ActivisionClient } from "./clients/ActivisionClient";

export class GameStatsFetcher {
    public steam: SteamClient;
    public riot: RiotClient;
    public activision: ActivisionClient;

    constructor(config: {
        steamApiKey: string;
        riotApiKey: string;
        activision: { email: string; password: string };
    }) {
        this.steam = new SteamClient(config.steamApiKey);
        this.riot = new RiotClient(config.riotApiKey);
        this.activision = new ActivisionClient(config.activision);
    }
}

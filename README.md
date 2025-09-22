# GameStatsFetcher

A modular Node.js package for fetching player statistics from gaming platforms such as Steam, Riot, and Activision.

## Installation

```bash
npm install game-stats-fetcher
```

## Usage

```ts
import { GameStatsFetcher } from "gamestats-fetcher";

const gs = new GameStatsFetcher({
  steamApiKey: "STEAM_KEY",
  riotApiKey: "RIOT_KEY",
  activision: { email: "test@mail.com", password: "secret" }
});

// Example usage
const steamStats = await fetcher.steam.getPlayerStats("76561198000000000");
const riotStats = await fetcher.riot.getSummonerByName("PlayerName", "euw1");
const codStats = await fetcher.activision.getWarzoneStats(
  "GamerTag#1234567",
  "battle"
);
```

## Supported Platforms

- ✅ Steam
- ✅ Riot (League of Legends, Valorant)
- ✅ Activision (Warzone, Modern Warfare)

## 📦 Publishing to npm

```bash
npm login
npm publish --access public
```

## Features

- Modular and extensible architecture
- Unified API for multiple platforms
- Easy to integrate into Node.js projects
- Supports Steam, Riot Games, and Activision

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests to add more platforms or improve existing functionality.

export class ActivisionClient {
    private ssoToken: string | null = null;
    private xsrfToken: string | null = null;

    constructor(private credentials: { email: string; password: string }) {}

    /**
     * Log in to Activision and store tokens
     */
    private async login() {
        if (this.ssoToken) return; // already logged in

        const url = "https://my.callofduty.com/api/papi-client/crm/cod/v2/login";
        const body = {
            email: this.credentials.email,
            password: this.credentials.password,
        };

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": "GameStatsFetcher/1.0.0",
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            throw new Error(`Login failed: ${res.statusText}`);
        }

        const setCookies: string[] = (res.headers as any).getSetCookie?.() || [];
        if (!setCookies.length) {
            throw new Error("No cookies returned from login");
        }

        const sso = setCookies.find((c: string) => c.startsWith("ACT_SSO_COOKIE="));
        const xsrf = setCookies.find((c: string) => c.startsWith("XSRF-TOKEN="));

        if (!sso) throw new Error("Missing ACT_SSO_COOKIE in login response");

        this.ssoToken = sso.split(";")[0].split("=")[1];
        if (xsrf) {
            this.xsrfToken = xsrf.split(";")[0].split("=")[1];
        }
    }

    /**
     * Wrapper for authenticated requests
     */
    private async authGet(url: string) {
        await this.login();

        const res = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent": "GameStatsFetcher/1.0.0",
                "Cookie": `ACT_SSO_COOKIE=${this.ssoToken}; XSRF-TOKEN=${this.xsrfToken || ""}`,
                "X-XSRF-TOKEN": this.xsrfToken || "",
            },
        });

        if (!res.ok) {
            throw new Error(`Request failed: ${res.statusText}`);
        }

        return res.json();
    }

    async getPlayerProfile(title: string, platform: string, gamertag: string) {
        const url = `https://my.callofduty.com/api/papi-client/stats/cod/v1/title/${title}/platform/${platform}/gamer/${encodeURIComponent(
            gamertag
        )}/profile/type/mp`;
        return await this.authGet(url);
    }

    async getWarzoneStats(gamertag: string, platform: string) {
        const url = `https://my.callofduty.com/api/papi-client/stats/cod/v1/title/mw/platform/${platform}/gamer/${encodeURIComponent(
            gamertag
        )}/profile/type/warzone`;
        return await this.authGet(url);
    }

    async getMultiplayerStats(title: string, gamertag: string, platform: string) {
        const url = `https://my.callofduty.com/api/papi-client/stats/cod/v1/title/${title}/platform/${platform}/gamer/${encodeURIComponent(
            gamertag
        )}/profile/type/mp`;
        return await this.authGet(url);
    }

    async getRecentMatches(title: string, gamertag: string, platform: string) {
        const url = `https://my.callofduty.com/api/papi-client/crm/cod/v2/title/${title}/platform/${platform}/gamer/${encodeURIComponent(
            gamertag
        )}/matches/mp/start/0/end/0/details`;
        return await this.authGet(url);
    }

    async getMatchDetails(title: string, matchId: string, platform: string) {
        const url = `https://my.callofduty.com/api/papi-client/crm/cod/v2/title/${title}/platform/${platform}/fullMatch/${matchId}/it`;
        return await this.authGet(url);
    }

    async getLeaderboards(title: string, platform: string, mode: string = "mp") {
        const url = `https://my.callofduty.com/api/papi-client/leaderboards/v2/title/${title}/platform/${platform}/time/alltime/type/${mode}/page/1`;
        return await this.authGet(url);
    }

    async searchPlayer(username: string, platform: string) {
        const url = `https://my.callofduty.com/api/papi-client/crm/cod/v2/platform/${platform}/username/${encodeURIComponent(
            username
        )}/search`;
        return await this.authGet(url);
    }
}

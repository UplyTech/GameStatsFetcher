/**
 * Simple GET request wrapper with optional headers
 */
export async function get(url: string, options: RequestInit = {}) {
    const res = await fetch(url, {
        method: "GET",
        headers: {
            "User-Agent": "GameStatsFetcher/1.0.0",
            ...(options.headers || {}),
        },
        ...options,
    });

    if (!res.ok) {
        throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
    }

    return res.json();
}

/**
 * Simple POST request wrapper with JSON body
 */
export async function post(url: string, body: any, options: RequestInit = {}) {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "GameStatsFetcher/1.0.0",
            ...(options.headers || {}),
        },
        body: JSON.stringify(body),
        ...options,
    });

    if (!res.ok) {
        throw new Error(`POST ${url} failed: ${res.status} ${res.statusText}`);
    }

    return res.json();
}

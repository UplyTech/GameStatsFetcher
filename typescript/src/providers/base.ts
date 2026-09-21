/**
 * The base every provider module extends.
 *
 * A provider knows one upstream API: its base URL, how it authenticates, and
 * how to turn its payloads into the canonical model. It does not know about
 * titles - `CS2Client` and `Dota2Client` both talk to the same `SteamProvider`,
 * and that is what keeps one Steam quota being spent once.
 *
 * Providers are constructed lazily and memoised per runtime, so an application
 * that only ever asks about Valorant never builds the other forty.
 */

import type { RequestSpec } from "../http.js";
import type { Runtime } from "../runtime.js";
import { getProvider } from "../providers.js";
import { MissingCredentialError, ValidationError } from "../errors.js";
import { resolveTtl } from "../cache.js";
import type { ProviderDescriptor } from "../types.js";

export abstract class ProviderClient {
  public readonly descriptor: ProviderDescriptor;
  protected readonly runtime: Runtime;

  constructor(providerId: string, runtime: Runtime) {
    this.descriptor = getProvider(providerId);
    this.runtime = runtime;
  }

  /** Short id, used in cache keys and error messages. */
  public get id(): string {
    return this.descriptor.id;
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  /** True when this provider has everything it needs to make a call. */
  public hasCredentials(): boolean {
    if (this.descriptor.auth === "none" || this.descriptor.optionalAuth) return true;
    const keyName = this.descriptor.keyName;
    if (!keyName) return true;
    const value = this.runtime.apiKeys[keyName];
    return typeof value === "string" && value.length > 0;
  }

  /**
   * The configured credential, or a {@link MissingCredentialError} naming both
   * the option to set and the page it comes from.
   */
  protected requireKey(titleId?: string): string {
    const keyName = this.descriptor.keyName;
    if (!keyName) {
      throw new ValidationError(`${this.id} does not use an API key`);
    }
    const value = this.runtime.apiKeys[keyName];
    if (typeof value !== "string" || value.length === 0) {
      throw new MissingCredentialError(this.id, keyName, this.descriptor.docsUrl, titleId);
    }
    return value;
  }

  /**
   * Split a colon-joined credential such as `clientId:clientSecret`.
   *
   * Blizzard, Abios, osu!, Hi-Rez, iRacing and Toornament all need two or three
   * values, and one option per provider pair would double the size of
   * {@link ApiKeys} for no gain.
   */
  protected requireKeyParts(count: number, labels: string, titleId?: string): string[] {
    const raw = this.requireKey(titleId);
    const parts = raw.split(":");
    if (parts.length < count) {
      throw new ValidationError(
        `apiKeys.${this.descriptor.keyName} must be "${labels}" (${count} values joined by ":")`,
      );
    }
    // Rejoin any overflow into the last part: an iRacing password may contain a
    // colon, and splitting one off would corrupt it silently.
    if (parts.length > count) {
      const head = parts.slice(0, count - 1);
      head.push(parts.slice(count - 1).join(":"));
      return head;
    }
    return parts;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Attach this provider's credential.
   *
   * The default covers the four mechanical auth kinds. Providers with a session
   * or an OAuth exchange override it - see `BlizzardProvider` and
   * `HiRezProvider`.
   */
  protected async authorize(spec: RequestSpec): Promise<RequestSpec> {
    switch (this.descriptor.auth) {
      case "none":
        return spec;
      case "bearer":
        return {
          ...spec,
          headers: { Authorization: `Bearer ${this.requireKey()}`, ...spec.headers },
        };
      case "header-key":
        return {
          ...spec,
          headers: { [this.authHeaderName()]: this.requireKey(), ...spec.headers },
        };
      case "query-key":
        return {
          ...spec,
          query: { [this.authQueryName()]: this.requireKey(), ...spec.query },
        };
      case "basic": {
        const encoded = Buffer.from(this.requireKey()).toString("base64");
        return { ...spec, headers: { Authorization: `Basic ${encoded}`, ...spec.headers } };
      }
      default:
        // The session-based kinds must override this; reaching here is a bug in
        // the provider module rather than in the caller's code.
        throw new ValidationError(
          `${this.id} uses ${this.descriptor.auth} auth but does not implement authorize()`,
        );
    }
  }

  /** Header the credential goes in, for `header-key` providers. */
  protected authHeaderName(): string {
    return "Authorization";
  }

  /** Query parameter the credential goes in, for `query-key` providers. */
  protected authQueryName(): string {
    return "key";
  }

  /**
   * Send a request to this provider.
   *
   * `path` may be absolute - several providers answer with a URL to follow, and
   * PUBG's telemetry lives on a different host entirely.
   */
  protected async request<T>(path: string, spec: RequestSpec = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${this.descriptor.baseUrl}${path}`;
    const authorized = await this.authorize(spec);
    return this.runtime.http.send<T>(this.id, url, authorized);
  }

  /** `GET`, which is almost every call in this package. */
  protected get<T>(path: string, spec: Omit<RequestSpec, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...spec, method: "GET" });
  }

  /** `POST` with a JSON body. */
  protected post<T>(path: string, json: unknown, spec: Omit<RequestSpec, "method" | "json"> = {}): Promise<T> {
    return this.request<T>(path, { ...spec, method: "POST", json });
  }

  /**
   * One GraphQL request.
   *
   * start.gg and STRATZ are GraphQL-only, and both report errors in a 200
   * response body - so a plain `post` would treat a failed query as a success
   * and hand the caller a payload full of nulls.
   */
  protected async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
    path = "",
  ): Promise<T> {
    const response = await this.post<{ data?: T; errors?: { message?: string }[] }>(
      path,
      { query, variables },
    );
    if (response?.errors?.length) {
      const detail = response.errors.map((e) => e.message ?? "unknown").join("; ");
      const { ParseError } = await import("../errors.js");
      throw new ParseError(this.id, `GraphQL error: ${detail}`);
    }
    if (!response || response.data === undefined) {
      const { ParseError } = await import("../errors.js");
      throw new ParseError(this.id, "GraphQL response contained no data");
    }
    return response.data;
  }

  // -------------------------------------------------------------------------
  // Caching
  // -------------------------------------------------------------------------

  /**
   * Read through the shared cache.
   *
   * The key is namespaced by provider so two providers serving the same title
   * cannot collide - `steam:cs2:stats:76561…` and `faceit:cs2:stats:76561…`
   * are different answers to the same question and both are worth keeping.
   */
  protected async cached<T>(
    parts: readonly (string | number)[],
    method: string,
    titleId: string,
    methodDefaultTtl: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const key = [this.id, ...parts].join(":");
    const hit = await this.runtime.cache.get<T>(key);
    if (hit !== null) {
      this.runtime.logger.debug(`[gsf] cache hit ${key}`);
      return hit;
    }
    const fresh = await fetcher();
    const ttl = resolveTtl(
      this.runtime.ttlOverrides,
      titleId,
      method,
      methodDefaultTtl,
      this.runtime.defaultTtlSeconds,
    );
    await this.runtime.cache.set(key, fresh, ttl);
    return fresh;
  }

  /** Remember a value for the life of the client - OAuth tokens, sessions. */
  protected async memo<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
    const scoped = `${this.id}:${key}`;
    const existing = this.runtime.state.get(scoped) as
      | { value: T; expiresAt: number }
      | undefined;
    if (existing && existing.expiresAt > Date.now()) return existing.value;
    const value = await factory();
    this.runtime.state.set(scoped, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }
}

/**
 * Lazily construct and memoise providers.
 *
 * Keyed by provider id on the runtime, so a client that touches ten titles
 * across four providers builds four provider objects and no more.
 */
export function useProvider<T extends ProviderClient>(
  runtime: Runtime,
  id: string,
  factory: (runtime: Runtime) => T,
): T {
  const key = `provider:${id}`;
  const existing = runtime.state.get(key) as T | undefined;
  if (existing) return existing;
  const created = factory(runtime);
  runtime.state.set(key, created);
  return created;
}

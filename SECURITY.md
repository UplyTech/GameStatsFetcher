# Security Policy

## Reporting a vulnerability

Please report security issues privately to **<security@uplytech.de>** rather than
in a public issue.

| | |
|---|---|
| First response | within 48 hours |
| Fix or mitigation plan | within 5 working days |
| Disclosure | coordinated, after a fix is available |

Include the title, the provider, and the sequence of calls that demonstrates the
problem. Reproduction steps matter more than severity claims.

## What this package holds

Unlike the rest of the UplyTech packages, this one **handles credentials and
opens sockets**. Thirty-four API keys can pass through it, and it talks to
fifty-three third-party hosts. That shapes the whole of what follows.

What it does with them:

- Keys live only in the `apiKeys` / `api_keys` option you pass, held on the
  client object for its lifetime. Nothing is read from the environment, nothing
  is written to disk, nothing is cached. Both editions copy the mapping rather
  than hold a reference to yours.
- A key is attached to a request in exactly one place — `authorize()` in
  `typescript/src/providers/base.ts` and `python/src/gamestatsfetcher/providers/base.py`,
  or a provider's override of it.
- **No error ever carries a credential.** `GameStatsError.toJSON()` (and
  `to_dict()` in Python) returns the code, the provider, the status and the
  message, and there is no path by which
  a key reaches any of them. `MissingCredentialError` names the *option* and the
  documentation page, never a value.
- **Every configured key is redacted from every message, defensively.** Eight
  providers authenticate by query parameter, so their key is in the URL — and
  two things an error carries can still hold one: a transport failure whose
  message some runtimes build from the URL, and an upstream error *body*,
  because a surprising number of APIs answer `{"error": "invalid api key:
  abc123"}` with the key quoted back. Both are passed through `redactSecrets` /
  `redact_secrets` when the error is **constructed**, not when it is printed, so
  the value never exists in an object something else might serialise. The
  longest match wins, so a `clientId:clientSecret` pair is replaced whole rather
  than leaving the secret next to three asterisks. A credential of one or two
  characters is left alone: that is a test fixture or a misconfiguration, and
  redacting it would turn every message into asterisks and hide the real
  problem.
- **Nothing is logged by default.** The logger is silent unless you configure
  one, and even at `debug` it prints cache keys and provider ids, not payloads.
  The Python edition's default is a `logging.Logger` with a `NullHandler` and
  `propagate` off, so it cannot write into your application's log format
  uninvited either.

## What counts as a vulnerability here

- **A credential leaking anywhere it should not.** Into an error message, into
  a log line, into a cache key, into a URL that gets recorded — or, worst,
  attached to a request for a *different* provider.
- **A cached response being served to the wrong caller.** Cache keys are
  namespaced by provider and by every identifying parameter; a collision that
  let one player's data answer a query about another would be serious.
- **Server-side request forgery.** Every URL this package builds comes from a
  provider descriptor plus encoded parameters. A path that let caller input
  choose the *host* would be a vulnerability. If you find one, that is the
  report we most want.
- **An injection through an identifier.** Player names contain slashes,
  question marks and hashes. Every one that reaches a URL goes through
  `encodeURIComponent`; a path where it does not is a bug worth reporting.
- **Denial of service from a plausible input.** A `limit` that makes the client
  fan out unboundedly, a redirect loop, a response that makes the parser hang.
- **A rate-limit bypass.** The buckets exist to keep operators inside terms of
  service. A code path that skips them can get a user's key revoked, which is a
  real consequence even though it is not a classic vulnerability.
- **A payload that escapes as something other than a `GameStatsError`.** An
  upstream that has been compromised, impersonated, or merely changed can send
  anything, and a mapper meeting a shape it was not written for used to throw a
  bare `AttributeError` or `TypeError` — past the `except GameStatsError` an
  application had wrapped every call in, and into whatever handles an unexpected
  crash. Every one of the fourteen methods now translates such a failure into a
  `ParseError` naming the title and the call, and a sweep of 87 titles × 14
  methods × 10 payload shapes asserts it in both editions
  (`test_hostile_payloads.py`, `hostile-payloads.test.ts`). A payload shape that
  still escapes is worth reporting.

## What is not a vulnerability

- **A third-party API being wrong, down or compromised.** This package is a
  client. If a provider serves bad data, that is the provider's incident — but
  do tell us, because we may need to change a default or drop it.
- **A key you configured being used.** Passing a key means requests will be made
  with it. That is the point.
- **Data being visible that the game already publishes.** Everything here comes
  from public endpoints. If a player's stats are visible through this package,
  they are visible on the provider's own site.
- **`raw` containing more than the normalised fields.** That is deliberate and
  documented. It contains exactly what the provider returned.

## Notes for operators

These are the mistakes that actually cause incidents.

1. **Use separate keys per environment.** Several providers here — the three
   Supercell APIs in particular — bind tokens to IP addresses, so a shared key
   fails confusingly rather than safely. Riot development keys expire every 24
   hours; a production deployment on one will break daily.

2. **Do not log the options object.** Everything else in this package is safe
   to log. `client.getOptions()` is not — it returns your keys. There is a
   reason `diagnostics()` exists and reports only *which option is missing*.

3. **Respect the two providers whose limits are terms of use.** Esports
   Earnings asks for at most one request per second; Liquipedia asks for one
   per two seconds, a User-Agent with a contact address, and 30-day caching of
   parsed results. This package enforces all of that by default. Raising those
   limits through `rateLimit` is a decision to breach an agreement, and it gets
   applications blocked.

4. **Set a `userAgent` that identifies you.** Several providers require it and
   more will start to. A generic one is refused by Liquipedia, GGG and
   trackmania.io outright.

5. **Share one client.** Two clients mean two caches and two sets of rate
   limiters against one real quota. This is the most common cause of
   unexplained 429s.

6. **Treat `raw` as untrusted.** It is a third party's payload, unmodified. If
   you render it, escape it; if you store it, validate it. The normalised
   fields are coerced and bounded, `raw` is not.

## Supported versions

| Version | Supported |
|---|---|
| 3.x | yes |
| 2.x | security fixes until 2027-03-01 |
| 1.x | no |

Security fixes ship as a patch release and are back-ported to the previous
major for six months after a new major is released.

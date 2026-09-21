# Support

| You want to | Go to |
|---|---|
| Understand how something works | [README](../README.md), [Python edition](../python/README.md), [TypeScript edition](../typescript/README.md) |
| See it working | [`python/examples/`](../python/examples), [`typescript/examples/`](../typescript/examples) |
| Ask "how do I ...?" | [Discussions](https://github.com/uplytech/gamestatsfetcher/discussions) |
| Report a wrong answer | [Bug report](https://github.com/uplytech/gamestatsfetcher/issues/new?template=bug_report.yml) |
| Report that the two editions disagree | [Edition drift](https://github.com/uplytech/gamestatsfetcher/issues/new?template=edition_drift.yml) |
| Report a security problem | **<security@uplytech.de>**, never a public issue - see [SECURITY.md](../SECURITY.md) |

## Before you open an issue

GameStatsFetcher reads player statistics from game providers and normalises them. It talks to other people's APIs, so most of what can go wrong is upstream rather than here.

Check the boundaries in [CONTRIBUTING.md](../CONTRIBUTING.md) first: most
questions turn out to be about something on the other side of them, and the
answer is then "your code", not "this library".

## Response times

This is maintained alongside other work, so an issue may sit for a few days.
Two things are treated differently:

- **Security reports** - first response within 48 hours (see SECURITY.md).
- **Edition drift** - the two editions disagreeing breaks the promise the whole
  library rests on. It is picked up ahead of everything else and never goes
  stale.

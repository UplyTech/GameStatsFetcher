#!/usr/bin/env python
"""Two-tier coverage gate, matching the TypeScript edition's.

One number over 6,700 statements says almost nothing here, because the package
is two very different kinds of code:

**The core** - transport, cache, rate limiter, normalisation, identity, the
registries, the client. Every line is reachable from a test with no network, and
a gap in it is a real gap. Held to 90 %.

**The mapping layer** - 12 provider modules and 11 title-client modules, which
turn 53 upstream schemas into the canonical model. Line coverage here measures
how many payload fixtures somebody wrote, not whether the mapping is right; the
contract suite walks all 87 titles and every method, and the hostile-payload
sweep walks them again against ten payloads no mapper was written for. Held to
65 %, which is roughly what those two sweeps reach on their own - so the floor
catches a module that has fallen out of both without pretending a fixture per
branch would prove anything.

    python scripts/coverage_gate.py            # after `pytest --cov`
    python scripts/coverage_gate.py --run      # run the suite first

Exits non-zero when either tier is under its floor, naming which.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

#: Floors, and the reasoning is in the module docstring above.
CORE_FLOOR = 90.0
MAPPING_FLOOR = 65.0

#: Everything under these is the mapping layer. The rest is core.
MAPPING_PREFIXES = ("gamestatsfetcher/providers/", "gamestatsfetcher/games/")

#: Not measured: it is a data file with no behaviour, and the models are covered
#: wherever they are constructed.
EXCLUDED = ("gamestatsfetcher/data/",)


def tier(path: str) -> str:
    normalised = path.replace("\\", "/")
    if any(normalised.startswith(p) or f"/{p}" in normalised for p in EXCLUDED):
        return "excluded"
    if any(p in normalised for p in MAPPING_PREFIXES):
        return "mapping"
    return "core"


def main() -> int:
    if "--run" in sys.argv:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "--cov",
                "--cov-report=",
                "--cov-fail-under=0",
                "-q",
            ],
            cwd=ROOT,
        )
        if result.returncode != 0:
            print("\ntests failed - fix those before looking at coverage", file=sys.stderr)
            return result.returncode

    try:
        from coverage import Coverage
    except ImportError:
        print('coverage is not installed. `pip install -e ".[dev]"`', file=sys.stderr)
        return 1

    coverage = Coverage(data_file=str(ROOT / ".coverage"))
    try:
        coverage.load()
    except Exception as error:  # noqa: BLE001 - the message is the useful part
        print(f"no coverage data: {error}", file=sys.stderr)
        print("Run `pytest --cov` first, or pass --run.", file=sys.stderr)
        return 1

    data = coverage.get_data()
    measured = data.measured_files()
    if not measured:
        print("coverage data is empty - did the suite run?", file=sys.stderr)
        return 1

    totals: dict[str, list[int]] = {"core": [0, 0], "mapping": [0, 0]}
    worst: dict[str, list[tuple[float, str]]] = {"core": [], "mapping": []}

    for filename in sorted(measured):
        analysis = coverage._analyze(filename)  # noqa: SLF001 - the public API is the report
        name = tier(analysis.filename)
        if name == "excluded":
            continue

        statements = len(analysis.statements)
        missing = len(analysis.missing)
        if statements == 0:
            continue

        totals[name][0] += statements - missing
        totals[name][1] += statements
        percent = (statements - missing) / statements * 100
        worst[name].append((percent, Path(analysis.filename).name))

    failed = False
    for name, floor in (("core", CORE_FLOOR), ("mapping", MAPPING_FLOOR)):
        covered, statements = totals[name]
        if statements == 0:
            print(f"{name}: nothing measured - the tier split is probably wrong")
            failed = True
            continue

        percent = covered / statements * 100
        status = "ok" if percent >= floor else "FAIL"
        print(
            f"{status:>4}  {name:<8} {percent:6.2f}%  "
            f"({covered}/{statements} statements, floor {floor:.0f}%)"
        )

        if percent < floor:
            failed = True
            print("      lowest-covered files in this tier:")
            for value, filename in sorted(worst[name])[:5]:
                print(f"        {value:6.2f}%  {filename}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

"""The registry data shipped here must match ``shared/registry/``.

The TypeScript edition owns the title list and the reconciliation that keeps it
honest. This edition ships the generated result as package data so a wheel is
self-contained - somebody who ``pip install``s the package does not have the
repository checked out.

That leaves exactly one failure mode: the copy going stale. A stale copy is not
a build error, it is two editions quietly disagreeing about what a title can do,
which is the specific thing the shared registry exists to prevent. So the check
runs here rather than only in CI.

When this fails, run::

    python scripts/sync_registry.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from gamestatsfetcher import (
    REGISTRY_FORMAT_VERSION,
    list_providers,
    list_titles,
    title_count,
)

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT.parent / "shared" / "registry"
PACKAGE_DATA = ROOT / "src" / "gamestatsfetcher" / "data"

FILES = ("titles.json", "providers.json")

#: The repository checkout. A wheel installed from PyPI has package data but no
#: ``shared/`` directory, and the drift tests below are skipped there - there is
#: nothing to drift from.
IN_REPOSITORY = SHARED.is_dir()

needs_repository = pytest.mark.skipif(
    not IN_REPOSITORY, reason="shared/registry is only present in a checkout"
)


class TestPackageData:
    """These run everywhere, including from an installed wheel."""

    @pytest.mark.parametrize("name", FILES)
    def test_the_file_ships(self, name: str) -> None:
        # Without this, the package imports in a checkout and fails at import
        # time for everyone who installed it - the worst place to find out.
        assert (PACKAGE_DATA / name).is_file(), f"{name} is missing from package data"

    @pytest.mark.parametrize("name", FILES)
    def test_the_format_version_is_one_this_edition_understands(self, name: str) -> None:
        payload = json.loads((PACKAGE_DATA / name).read_text("utf-8"))
        assert payload["formatVersion"] == REGISTRY_FORMAT_VERSION

    def test_what_was_loaded_matches_what_is_on_disk(self) -> None:
        titles = json.loads((PACKAGE_DATA / "titles.json").read_text("utf-8"))
        providers = json.loads((PACKAGE_DATA / "providers.json").read_text("utf-8"))
        assert title_count() == len(titles["titles"])
        assert len(list_providers()) == len(providers["providers"])

    def test_the_loader_preserves_declaration_order(self) -> None:
        # Provider order inside a title is a preference order, and title order is
        # what an unfiltered listing shows. A loader that sorted would change
        # which source answers a question.
        on_disk = json.loads((PACKAGE_DATA / "titles.json").read_text("utf-8"))
        assert [t.id for t in list_titles()] == [row["id"] for row in on_disk["titles"]]


@needs_repository
class TestNoDrift:
    """These need the repository, and are the point of the file."""

    @pytest.mark.parametrize("name", FILES)
    def test_the_copy_is_byte_for_byte_current(self, name: str) -> None:
        # Compared as bytes rather than as parsed JSON: the generator writes
        # deterministically, so any difference at all means the copy is stale.
        shared = (SHARED / name).read_bytes()
        shipped = (PACKAGE_DATA / name).read_bytes()
        assert shipped == shared, (
            f"src/gamestatsfetcher/data/{name} is out of date. "
            "Run `python scripts/sync_registry.py` and commit the result."
        )

    def test_the_sync_script_agrees(self) -> None:
        # The same check the CI step runs, so a green suite means a green CI
        # step rather than two implementations of "current".
        import subprocess
        import sys

        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "sync_registry.py"), "--check"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stdout + result.stderr

    def test_coverage_json_is_not_shipped(self) -> None:
        # It is a documentation view, not something the runtime reads. Shipping
        # it would add a third file to keep in sync for no gain.
        assert not (PACKAGE_DATA / "coverage.json").exists()

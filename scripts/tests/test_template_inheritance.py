import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "template_inheritance.py"
SPEC = importlib.util.spec_from_file_location("template_inheritance", MODULE_PATH)
inheritance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inheritance)

PARENT, COMMIT = "acme/parent-template", "a" * 40


def valid_manifest():
    return {
        "schema_version": 1,
        "parent": {"repository": PARENT, "branch": "main"},
        "lock_file": ".github/inheritance/lock.json",
        "inherited_paths": [".ai/", "scripts/template_inheritance.py"],
        "protected_paths": [
            ".gitignore",
            ".github/governance/repository.json",
            ".github/inheritance/lock.json",
            ".github/inheritance/manifest.json",
            ".github/workflows/template-sync.yml",
            ".templatesyncignore",
        ],
    }


def valid_lock():
    return {"schema_version": 1, "parent": {"repository": PARENT, "commit": COMMIT}}


class TemplateInheritanceTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.root = Path(self.temporary_directory.name) / "child"
        self.inheritance_directory = self.root / ".github/inheritance"
        self.inheritance_directory.mkdir(parents=True)
        self.manifest_path = self.inheritance_directory / "manifest.json"
        self.lock_path = self.inheritance_directory / "lock.json"
        self.ignore_path = self.root / ".templatesyncignore"
        self.write_contract(valid_manifest(), valid_lock())
        self.write_ignore(valid_manifest()["protected_paths"] + [".github/workflows/**"])

    def write_contract(self, manifest, lock):
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        self.lock_path.write_text(json.dumps(lock), encoding="utf-8")

    def write_ignore(self, entries):
        self.ignore_path.write_text("\n".join(entries) + "\n", encoding="utf-8")

    def assert_manifest_error(self, manifest):
        self.write_contract(manifest, valid_lock())
        with self.assertRaises(inheritance.InheritanceError):
            inheritance.validate_inheritance(self.root)

    def test_valid_contract_returns_deterministic_ownership(self):
        result = inheritance.validate_inheritance(self.root)

        self.assertEqual(result["parent"], {"repository": PARENT, "branch": "main", "commit": COMMIT})
        expected = valid_manifest()
        self.assertEqual(result["ownership"]["inherited"], sorted(expected["inherited_paths"]))
        self.assertEqual(result["ownership"]["protected"], sorted(expected["protected_paths"]))

    def test_manifest_rejects_unknown_or_invalid_boundary_values(self):
        mutations = [
            lambda value: value.update(schema_version=2),
            lambda value: value["parent"].update(repository="not-a-target"),
            lambda value: value["parent"].update(branch="../main"),
            lambda value: value.update(inherited_paths=[]),
            lambda value: value.update(inherited_paths=[f"file-{index}" for index in range(1_001)]),
            lambda value: value.update(unknown=True),
        ]
        mutations.extend(
            lambda value, path=path: value.update(inherited_paths=[path])
            for path in ("../secret", "/absolute", "docs//file", "docs/**", ".git/config")
        )
        for mutate in mutations:
            manifest = valid_manifest()
            mutate(manifest)
            with self.subTest(manifest=manifest):
                self.assert_manifest_error(manifest)

    def test_overlapping_ownership_roots_are_rejected(self):
        for inherited, protected in (
            (["docs/", "docs/api/"], None),
            ([".ai/"], ".ai/mission.md"),
        ):
            manifest = valid_manifest()
            manifest["inherited_paths"] = inherited
            if protected:
                manifest["protected_paths"].append(protected)
            with self.subTest(manifest=manifest):
                self.assert_manifest_error(manifest)

    def test_required_child_owned_paths_cannot_be_omitted(self):
        for path in (".gitignore", ".github/inheritance/lock.json"):
            manifest = valid_manifest()
            manifest["protected_paths"].remove(path)
            with self.subTest(path=path):
                self.assert_manifest_error(manifest)

    def test_every_protected_root_must_be_covered_by_template_sync_ignore(self):
        self.write_ignore(
            path for path in valid_manifest()["protected_paths"] if path != ".gitignore"
        )

        with self.assertRaisesRegex(
            inheritance.InheritanceError,
            r"template sync ignore.*\.gitignore",
        ):
            inheritance.validate_inheritance(self.root)

    def test_template_sync_must_exclude_every_workflow(self):
        self.write_ignore(valid_manifest()["protected_paths"])

        with self.assertRaisesRegex(
            inheritance.InheritanceError,
            r"template sync ignore.*\.github/workflows/",
        ):
            inheritance.validate_inheritance(self.root)

    def test_template_sync_exception_cannot_reinclude_a_protected_root(self):
        self.write_ignore(
            valid_manifest()["protected_paths"]
            + [".github/workflows/**", ":!.github/workflows/security.yml"]
        )

        with self.assertRaisesRegex(
            inheritance.InheritanceError,
            r"template sync exception.*security.yml",
        ):
            inheritance.validate_inheritance(self.root)

    def test_lock_must_match_parent_and_pin_a_full_commit(self):
        for parent, commit in (("acme/other", COMMIT), (PARENT, "abc123"), (PARENT, "0" * 40)):
            lock = valid_lock()
            lock["parent"] = {"repository": parent, "commit": commit}
            self.write_contract(valid_manifest(), lock)
            with self.subTest(parent=parent, commit=commit):
                with self.assertRaises(inheritance.InheritanceError):
                    inheritance.validate_inheritance(self.root)

    def test_malformed_contract_files_are_rejected(self):
        cases = (
            ('{"schema_version": 1, "schema_version": 1}', "duplicate key"),
            (" " * (inheritance.MAX_CONTRACT_BYTES + 1), "exceeds"),
        )
        for content, pattern in cases:
            self.manifest_path.write_text(content, encoding="utf-8")
            with self.subTest(pattern=pattern), self.assertRaisesRegex(inheritance.InheritanceError, pattern):
                inheritance.validate_inheritance(self.root)

    def test_symlink_escape_is_rejected(self):
        outside_lock = Path(self.temporary_directory.name) / "outside-lock.json"
        outside_lock.write_text(json.dumps(valid_lock()), encoding="utf-8")
        self.manifest_path.write_text(json.dumps(valid_manifest()), encoding="utf-8")
        self.lock_path.unlink()
        self.lock_path.symlink_to(outside_lock)
        with self.assertRaisesRegex(inheritance.InheritanceError, "symlink"):
            inheritance.validate_inheritance(self.root)

    def test_cli_reports_valid_and_invalid_contracts(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = inheritance.main(["validate", "--root", str(self.root)])
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["parent"]["commit"], COMMIT)

        manifest = valid_manifest()
        manifest["protected_paths"].remove(".gitignore")
        self.write_contract(manifest, valid_lock())
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            exit_code = inheritance.main(["validate", "--root", str(self.root)])
        self.assertEqual(exit_code, 2)
        self.assertIn("inheritance error:", stderr.getvalue())

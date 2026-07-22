import contextlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "template_inheritance.py"
SPEC = importlib.util.spec_from_file_location("template_inheritance_plan", MODULE_PATH)
inheritance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inheritance)

PARENT_REPOSITORY = "acme/parent-template"
PROTECTED_PATHS = [
    ".gitignore",
    ".github/governance/repository.json",
    ".github/inheritance/lock.json",
    ".github/inheritance/manifest.json",
    ".github/workflows/template-sync.yml",
    ".templatesyncignore",
]


class TemplateInheritancePlanTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        temporary_root = Path(self.temporary_directory.name)
        self.parent = temporary_root / "parent"
        self.child = temporary_root / "child"
        self.parent.mkdir()
        self.child.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Test User")
        self.git("config", "user.email", "test@example.invalid")
        self.git("remote", "add", "origin", f"https://github.com/{PARENT_REPOSITORY}.git")

        for path, content in {
            "inherited/modify.txt": "old\n",
            "inherited/delete.txt": "old\n",
            "inherited/current.txt": "old\n",
            ".gitignore": "parent-old\n",
        }.items():
            self.write(self.parent, path, content)
        self.locked_commit = self.commit("base")

        for path, content in {
            "inherited/modify.txt": "old\n",
            "inherited/delete.txt": "old\n",
            "inherited/current.txt": "new\n",
            ".gitignore": "child-local\n",
        }.items():
            self.write(self.child, path, content)
        self.write_contract(self.locked_commit)

        for path, content in {
            "inherited/add.txt": "new\n",
            "inherited/modify.txt": "new\n",
            "inherited/current.txt": "new\n",
            ".gitignore": "parent-new\n",
            "unowned.txt": "new\n",
        }.items():
            self.write(self.parent, path, content)
        (self.parent / "inherited/delete.txt").unlink()
        self.candidate_commit = self.commit("candidate")
        self.write(self.parent, "inherited/later.txt", "later\n")
        self.target_commit = self.commit("later")
        self.git("update-ref", "refs/remotes/origin/main", self.target_commit)

    def git(self, *arguments):
        result = subprocess.run(
            ["git", "-C", str(self.parent), *arguments],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-m", message)
        return self.git("rev-parse", "HEAD")

    def write(self, root, relative_path, content):
        path = root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def write_contract(self, commit):
        manifest = {
            "schema_version": 1,
            "parent": {"repository": PARENT_REPOSITORY, "branch": "main"},
            "lock_file": ".github/inheritance/lock.json",
            "inherited_paths": ["inherited/"],
            "protected_paths": PROTECTED_PATHS,
        }
        lock = {"schema_version": 1, "parent": {"repository": PARENT_REPOSITORY, "commit": commit}}
        self.write(self.child, ".github/inheritance/manifest.json", json.dumps(manifest))
        self.write(self.child, ".github/inheritance/lock.json", json.dumps(lock))
        self.write(
            self.child,
            ".templatesyncignore",
            "\n".join(PROTECTED_PATHS + [".github/workflows/**"]) + "\n",
        )

    def snapshot_child(self):
        return {
            str(path.relative_to(self.child)): path.read_bytes()
            for path in self.child.rglob("*")
            if path.is_file()
        }

    def test_plan_selects_only_next_first_parent_commit_and_is_read_only(self):
        before = self.snapshot_child()
        result = inheritance.plan_inheritance(self.child, self.parent)

        self.assertEqual(result["status"], "changes")
        self.assertEqual(result["parent"]["candidate_commit"], self.candidate_commit)
        self.assertEqual(result["parent"]["target_commit"], self.target_commit)
        self.assertEqual(result["changes"]["add"], ["inherited/add.txt"])
        self.assertEqual(result["changes"]["modify"], ["inherited/modify.txt"])
        self.assertEqual(result["changes"]["candidate_delete"], ["inherited/delete.txt"])
        self.assertEqual(result["changes"]["already_current"], ["inherited/current.txt"])
        self.assertEqual(result["skipped"]["protected"], [".gitignore"])
        self.assertEqual(result["skipped"]["unowned"], ["unowned.txt"])
        self.assertNotIn("inherited/later.txt", json.dumps(result))
        self.assertEqual(self.snapshot_child(), before)

    def test_plan_reports_up_to_date_at_remote_branch_head(self):
        self.write_contract(self.target_commit)

        result = inheritance.plan_inheritance(self.child, self.parent)

        self.assertEqual(result["status"], "up_to_date")
        self.assertIsNone(result["parent"]["candidate_commit"])
        self.assertEqual(result["summary"]["total"], 0)

    def test_parent_origin_must_match_manifest(self):
        self.git("remote", "set-url", "origin", "https://github.com/acme/other.git")

        with self.assertRaisesRegex(inheritance.InheritanceError, "origin"):
            inheritance.plan_inheritance(self.child, self.parent)

    def test_lock_must_be_on_first_parent_history(self):
        self.git("switch", "-c", "side", self.locked_commit)
        self.write(self.parent, "side.txt", "side\n")
        side_commit = self.commit("side")
        self.git("switch", "main")
        self.git("merge", "--no-ff", "side", "-m", "merge side")
        self.git("update-ref", "refs/remotes/origin/main", self.git("rev-parse", "HEAD"))
        self.write_contract(side_commit)

        with self.assertRaisesRegex(inheritance.InheritanceError, "first-parent"):
            inheritance.plan_inheritance(self.child, self.parent)

    def test_inherited_child_symlink_is_rejected(self):
        outside = Path(self.temporary_directory.name) / "outside.txt"
        outside.write_text("outside\n", encoding="utf-8")
        (self.child / "inherited/modify.txt").unlink()
        (self.child / "inherited/modify.txt").symlink_to(outside)

        with self.assertRaisesRegex(inheritance.InheritanceError, "symlink"):
            inheritance.plan_inheritance(self.child, self.parent)

    def test_plan_cli_prints_the_same_candidate(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = inheritance.main(
                ["plan", "--root", str(self.child), "--parent-root", str(self.parent)]
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(stdout.getvalue())["parent"]["candidate_commit"], self.candidate_commit)

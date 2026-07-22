import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).parents[2]
IGNORE_FILE = REPOSITORY_ROOT / ".templatesyncignore"
WORKFLOW_FILE = REPOSITORY_ROOT / ".github" / "workflows" / "template-sync.yml"


class TemplateSyncIgnoreTest(unittest.TestCase):
    def entries(self):
        return {
            line.strip()
            for line in IGNORE_FILE.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }

    def test_foundation_docs_use_git_pathspec_exclusions(self):
        entries = self.entries()

        self.assertIn("docs/**", entries)
        self.assertIn(":!docs/foundation/", entries)
        self.assertIn(":!docs/foundation/**", entries)
        self.assertNotIn("!docs/foundation/", entries)
        self.assertNotIn("!docs/foundation/**", entries)

    def test_legacy_sync_excludes_every_workflow(self):
        self.assertIn(".github/workflows/**", self.entries())

    def test_sync_pr_records_the_source_commit_used_by_the_action(self):
        workflow = WORKFLOW_FILE.read_text(encoding="utf-8")

        self.assertIn("id: template-sync", workflow)
        self.assertIn("steps.template-sync.outputs.pr_branch", workflow)
        self.assertIn('gh api "repos/${SOURCE_REPOSITORY}/commits/${SOURCE_SHORT}"', workflow)
        self.assertIn("Unable to expand the Template Sync source commit", workflow)
        self.assertIn("gh pr edit", workflow)


if __name__ == "__main__":
    unittest.main()

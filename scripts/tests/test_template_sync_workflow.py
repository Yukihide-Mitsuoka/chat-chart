import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).parents[2]
WORKFLOW = REPOSITORY_ROOT / ".github" / "workflows" / "template-sync.yml"


class TemplateSyncWorkflowTest(unittest.TestCase):
    def test_pull_request_body_contains_exact_action_source_commit(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("id: template-sync", workflow)
        self.assertIn("steps.template-sync.outputs.pr_branch", workflow)
        self.assertIn('SOURCE_REPOSITORY: "Yukihide-Mitsuoka/ai-dev-foundation"', workflow)
        self.assertIn('gh api "repos/${SOURCE_REPOSITORY}/commits/${SOURCE_SHORT}"', workflow)
        self.assertIn("gh pr edit", workflow)


if __name__ == "__main__":
    unittest.main()

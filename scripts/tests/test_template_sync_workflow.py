import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).parents[2]
WORKFLOW = REPOSITORY_ROOT / ".github" / "workflows" / "template-sync.yml"


class TemplateSyncWorkflowTest(unittest.TestCase):
    def test_pull_request_body_contains_full_foundation_source_commit(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn(
            "git ls-remote https://github.com/Yukihide-Mitsuoka/ai-dev-foundation.git",
            workflow,
        )
        self.assertIn(
            'pr_body: "Foundation-source: '
            'https://github.com/Yukihide-Mitsuoka/ai-dev-foundation@'
            '${{ steps.foundation-source.outputs.sha }}"',
            workflow,
        )


if __name__ == "__main__":
    unittest.main()

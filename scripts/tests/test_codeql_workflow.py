import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class CodeQLWorkflowTest(unittest.TestCase):
    def test_all_executable_source_languages_are_analyzed(self) -> None:
        workflow = (ROOT / ".github/workflows/codeql.yml").read_text()

        self.assertIn("language: [javascript-typescript, python]", workflow)
        self.assertNotIn("language: []", workflow)


if __name__ == "__main__":
    unittest.main()

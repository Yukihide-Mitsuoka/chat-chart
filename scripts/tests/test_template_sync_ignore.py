import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).parents[2]
IGNORE_FILE = REPOSITORY_ROOT / ".templatesyncignore"


class TemplateSyncIgnoreTest(unittest.TestCase):
    def test_foundation_docs_use_git_pathspec_exclusions(self):
        entries = {
            line.strip()
            for line in IGNORE_FILE.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }

        self.assertIn("docs/**", entries)
        self.assertIn(":!docs/foundation/", entries)
        self.assertIn(":!docs/foundation/**", entries)
        self.assertNotIn("!docs/foundation/", entries)
        self.assertNotIn("!docs/foundation/**", entries)


if __name__ == "__main__":
    unittest.main()

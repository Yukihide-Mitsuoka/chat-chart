import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SHA = re.compile(r"[0-9a-f]{40}")
USES = re.compile(r"\buses:\s*([^\s#]+)")


class WorkflowDependencyPinsTest(unittest.TestCase):
    def test_external_workflow_dependencies_use_commit_shas(self) -> None:
        unpinned: list[str] = []
        for workflow in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            for line_number, line in enumerate(workflow.read_text().splitlines(), 1):
                match = USES.search(line)
                if not match:
                    continue
                target = match.group(1)
                if target.startswith(("./", "docker://")):
                    continue
                reference = target.rsplit("@", 1)[-1]
                if not SHA.fullmatch(reference):
                    unpinned.append(f"{workflow.relative_to(ROOT)}:{line_number}: {target}")

        self.assertEqual([], unpinned, "unpinned workflow dependencies:\n" + "\n".join(unpinned))


if __name__ == "__main__":
    unittest.main()

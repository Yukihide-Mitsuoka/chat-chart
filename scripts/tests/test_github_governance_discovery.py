import importlib.util
import json
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "github_governance.py"
SPEC = importlib.util.spec_from_file_location("github_governance_discovery", MODULE_PATH)
governance = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(governance)

SHA = "a" * 40


class Completed:
    def __init__(self, returncode=0, payload=None, stdout=None):
        self.returncode = returncode
        self.stdout = stdout if stdout is not None else json.dumps(payload) if payload is not None else ""
        self.stderr = "redacted API failure"


class FakeRunner:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        endpoint = command[-1]
        return self.responses.get(endpoint, Completed(returncode=1))


def repository_payload(security=True, admin=True):
    payload = {
        "allow_merge_commit": False,
        "allow_rebase_merge": False,
        "allow_squash_merge": True,
        "default_branch": "main",
        "delete_branch_on_merge": True,
        "full_name": "acme/demo",
        "has_discussions": True,
        "squash_merge_commit_message": "PR_BODY",
        "squash_merge_commit_title": "PR_TITLE",
    }
    if admin is not None:
        payload["permissions"] = {"admin": admin}
    if security:
        payload["security_and_analysis"] = {
            "secret_scanning": {"status": "enabled"},
            "secret_scanning_push_protection": {"status": "enabled"},
            "dependabot_security_updates": {"status": "disabled"},
        }
    return payload


def branch_payload(protected):
    return {"commit": {"sha": SHA}, "name": "main", "protected": protected}


def observed_check_responses():
    return {
        "repos/acme/demo/private-vulnerability-reporting": Completed(
            payload={"enabled": True}
        ),
        "repos/acme/demo/vulnerability-alerts": Completed(
            stdout="HTTP/2.0 204 No Content\r\n\r\n"
        ),
        "repos/acme/demo/rulesets?includes_parents=false&per_page=100": Completed(
            payload=[[]]
        ),
        f"repos/acme/demo/commits/{SHA}/check-runs?per_page=100": Completed(
            payload=[{"check_runs": [{"name": "test"}, {"name": "lint"}]}]
        ),
        f"repos/acme/demo/commits/{SHA}/statuses?per_page=100": Completed(
            payload=[[{"context": "deploy"}]]
        ),
    }


class GitHubDiscoveryTest(unittest.TestCase):
    def test_discovery_is_get_only_and_redacts_bypass_actor_details(self):
        rules = [
            {
                "type": "pull_request",
                "ruleset_id": 7,
                "ruleset_source_type": "Repository",
                "ruleset_source": "acme/demo",
                "parameters": {"required_approving_review_count": 1},
            },
        ]
        runner = FakeRunner(
            {
                **observed_check_responses(),
                "repos/acme/demo": Completed(payload=repository_payload()),
                "repos/acme/demo/branches/main": Completed(payload=branch_payload(True)),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(payload=[rules]),
                "repos/acme/demo/rulesets?includes_parents=false&per_page=100": Completed(
                    payload=[
                        [
                            {
                                "id": 8,
                                "name": "inactive governance",
                                "source": "acme/demo",
                                "source_type": "Repository",
                            }
                        ]
                    ]
                ),
                "repos/acme/demo/rulesets/7": Completed(
                    payload={
                        "bypass_actors": [{"actor_id": 123}],
                        "conditions": {
                            "ref_name": {"exclude": [], "include": ["refs/heads/main"]}
                        },
                        "id": 7,
                        "name": governance.MANAGED_RULESET_NAME,
                        "rules": [
                            {
                                "parameters": {
                                    "allowed_merge_methods": ["squash"],
                                    "dismiss_stale_reviews_on_push": True,
                                    "require_code_owner_review": True,
                                    "require_last_push_approval": False,
                                    "required_approving_review_count": 0,
                                    "required_review_thread_resolution": True,
                                },
                                "type": "pull_request",
                            },
                            {
                                "parameters": {
                                    "required_status_checks": [
                                        {"context": "lint", "integration_id": 42}
                                    ],
                                    "strict_required_status_checks_policy": True,
                                },
                                "type": "required_status_checks",
                            },
                            {"type": "non_fast_forward"},
                        ],
                        "target": "branch",
                    }
                ),
                "repos/acme/demo/branches/main/protection": Completed(
                    payload={
                        "enforce_admins": {"enabled": True},
                        "required_status_checks": {"strict": True, "contexts": ["lint"]},
                        "required_pull_request_reviews": {
                            "required_approving_review_count": 0,
                            "require_last_push_approval": False,
                        },
                        "allow_force_pushes": {"enabled": False},
                    }
                ),
            }
        )

        result = governance.discover_github("acme/demo", "main", runner=runner)

        self.assertEqual(result["rulesets"][0]["has_bypass_actors"], True)
        self.assertTrue(
            result["rulesets"][0]["update_state"]["pull_request"][
                "dismiss_stale_reviews_on_push"
            ]
        )
        self.assertEqual(
            result["rulesets"][0]["update_state"]["required_status_checks"][0][
                "integration_id"
            ],
            42,
        )
        self.assertEqual(result["rulesets"][1]["name"], "inactive governance")
        self.assertEqual(result["legacy_branch_protection"]["status"], "configured")
        self.assertEqual(result["observed_checks"], ["deploy", "lint", "test"])
        self.assertEqual(result["security"]["private_vulnerability_reporting"], "enabled")
        self.assertEqual(result["security"]["vulnerability_alerts"], "enabled")
        self.assertEqual(
            result["repository"],
            {
                "allow_merge_commit": False,
                "allow_rebase_merge": False,
                "allow_squash_merge": True,
                "default_branch": "main",
                "delete_branch_on_merge": True,
                "full_name": "acme/demo",
                "has_discussions": True,
                "squash_merge_commit_message": "PR_BODY",
                "squash_merge_commit_title": "PR_TITLE",
            },
        )
        self.assertNotIn("123", json.dumps(result))
        self.assertNotIn("repos/acme/demo/rulesets/8", [call[0][-1] for call in runner.calls])
        for command, kwargs in runner.calls:
            self.assertEqual(command[command.index("--method") + 1], "GET")
            self.assertIn("X-GitHub-Api-Version: 2026-03-10", command)
            self.assertEqual(kwargs["timeout"], 30)
            self.assertFalse({"POST", "PUT", "PATCH", "DELETE"} & set(command))

    def test_admin_invisible_fields_are_unknown(self):
        rules = [
            {
                "type": "pull_request",
                "ruleset_id": 9,
                "ruleset_source_type": "Repository",
                "ruleset_source": [],
            }
        ]
        runner = FakeRunner(
            {
                **observed_check_responses(),
                "repos/acme/demo": Completed(
                    payload=repository_payload(security=False, admin=None)
                ),
                "repos/acme/demo/private-vulnerability-reporting": Completed(returncode=1),
                "repos/acme/demo/vulnerability-alerts": Completed(
                    returncode=1,
                    stdout="HTTP/2.0 404 Not Found\r\n\r\n",
                ),
                "repos/acme/demo/branches/main": Completed(payload=branch_payload(True)),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(payload=[rules]),
            }
        )

        result = governance.discover_github("acme/demo", "main", runner=runner)

        self.assertEqual(result["security"]["secret_scanning"], "unknown")
        self.assertEqual(result["security"]["private_vulnerability_reporting"], "unknown")
        self.assertEqual(result["security"]["vulnerability_alerts"], "unknown")
        self.assertEqual(result["rulesets"][0]["has_bypass_actors"], "unknown")
        self.assertEqual(result["legacy_branch_protection"]["status"], "unknown")
        self.assertEqual(result["effective_rules"][0]["source"], "unknown")

    def test_unprotected_branch_skips_legacy_admin_endpoint(self):
        runner = FakeRunner(
            {
                **observed_check_responses(),
                "repos/acme/demo": Completed(payload=repository_payload()),
                "repos/acme/demo/branches/main": Completed(payload=branch_payload(False)),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(payload=[[]]),
            }
        )

        result = governance.discover_github("acme/demo", "main", runner=runner)

        self.assertEqual(result["legacy_branch_protection"]["status"], "absent")
        endpoints = [command[-1] for command, _ in runner.calls]
        self.assertNotIn("repos/acme/demo/branches/main/protection", endpoints)

    def test_ruleset_only_branch_treats_confirmed_legacy_404_as_absent(self):
        protection_endpoint = "repos/acme/demo/branches/main/protection"
        runner = FakeRunner(
            {
                **observed_check_responses(),
                "repos/acme/demo": Completed(payload=repository_payload()),
                "repos/acme/demo/branches/main": Completed(payload=branch_payload(True)),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(
                    payload=[[]]
                ),
                protection_endpoint: Completed(
                    returncode=1,
                    stdout="HTTP/2.0 404 Not Found\r\n\r\n",
                ),
            }
        )

        result = governance.discover_github("acme/demo", "main", runner=runner)

        self.assertEqual(result["legacy_branch_protection"]["status"], "absent")
        self.assertEqual(
            [command[-1] for command, _ in runner.calls].count(protection_endpoint),
            2,
        )

    def test_unreadable_legacy_status_remains_unknown_for_an_admin(self):
        runner = FakeRunner(
            {
                **observed_check_responses(),
                "repos/acme/demo": Completed(payload=repository_payload()),
                "repos/acme/demo/branches/main": Completed(payload=branch_payload(True)),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(
                    payload=[[]]
                ),
                "repos/acme/demo/branches/main/protection": Completed(returncode=1),
            }
        )

        result = governance.discover_github("acme/demo", "main", runner=runner)

        self.assertEqual(result["legacy_branch_protection"]["status"], "unknown")

    def test_admin_visible_disabled_security_controls_are_not_unknown(self):
        runner = FakeRunner(
            {
                **observed_check_responses(),
                "repos/acme/demo": Completed(payload=repository_payload()),
                "repos/acme/demo/branches/main": Completed(payload=branch_payload(False)),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(payload=[[]]),
                "repos/acme/demo/private-vulnerability-reporting": Completed(
                    payload={"enabled": False}
                ),
                "repos/acme/demo/vulnerability-alerts": Completed(
                    returncode=1,
                    stdout="HTTP/2.0 404 Not Found\r\n\r\n",
                ),
            }
        )

        result = governance.discover_github("acme/demo", "main", runner=runner)

        self.assertEqual(result["security"]["private_vulnerability_reporting"], "disabled")
        self.assertEqual(result["security"]["vulnerability_alerts"], "disabled")

    def test_required_read_failure_stops_closed(self):
        runner = FakeRunner({"repos/acme/demo": Completed(returncode=1)})

        with self.assertRaises(governance.PolicyError):
            governance.discover_github("acme/demo", "main", runner=runner)

    def test_invalid_check_run_page_stops_closed(self):
        runner = FakeRunner(
            {
                "repos/acme/demo": Completed(payload=repository_payload()),
                "repos/acme/demo/branches/main": Completed(payload=branch_payload(False)),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(payload=[[]]),
                f"repos/acme/demo/commits/{SHA}/check-runs?per_page=100": Completed(
                    payload=[[{"name": "lint"}]]
                ),
            }
        )

        with self.assertRaises(governance.PolicyError):
            governance.discover_github("acme/demo", "main", runner=runner)

    def test_invalid_branch_commit_sha_stops_closed(self):
        runner = FakeRunner(
            {
                "repos/acme/demo": Completed(payload=repository_payload()),
                "repos/acme/demo/branches/main": Completed(
                    payload={"commit": {"sha": "../main"}, "name": "main", "protected": False}
                ),
                "repos/acme/demo/rules/branches/main?per_page=100": Completed(payload=[[]]),
            }
        )

        with self.assertRaises(governance.PolicyError):
            governance.discover_github("acme/demo", "main", runner=runner)

    def test_runner_failure_stops_closed(self):
        def unavailable(*args, **kwargs):
            raise OSError("gh unavailable")

        with self.assertRaises(governance.PolicyError):
            governance.discover_github("acme/demo", "main", runner=unavailable)

    def test_invalid_repository_target_is_rejected_before_api_call(self):
        runner = FakeRunner({})

        with self.assertRaises(governance.PolicyError):
            governance.discover_github("../..", "main", runner=runner)

        self.assertEqual(runner.calls, [])


if __name__ == "__main__":
    unittest.main()

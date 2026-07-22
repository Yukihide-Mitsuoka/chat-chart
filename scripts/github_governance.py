#!/usr/bin/env python3
"""Validate and resolve inherited GitHub governance policy (ADR-0003)."""

import argparse
import copy
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote


SCHEMA_VERSION = 1
MANAGER = "ai-dev-foundation"
PROFILE_DIRECTORY = ".github/governance/profiles"
MAX_PROFILES = 32
API_VERSION = "2026-03-10"
UNKNOWN = "unknown"
MANAGED_RULESET_NAME = "ai-dev-foundation: branch-governance"
MINIMUM_CONTRACT = {
    "pull_request_required": (True, {"GR-010"}),
    "status_checks_required": (True, {"GR-012"}),
    "force_pushes_allowed": (False, {"GR-011"}),
    "admin_bypass_allowed": (False, {"GR-010", "GR-012"}),
    "squash_merge_only": (True, {"WF-030"}),
    "secret_scanning_enabled": (True, {"SEC-002"}),
    "push_protection_enabled": (True, {"SEC-002"}),
    "vulnerability_alerts_enabled": (True, {"SEC-003"}),
    "private_vulnerability_reporting_enabled": (True, {"SEC-003"}),
}
SETTING_FIELDS = {
    "target_branch",
    "enforcement_backend",
    "required_approvals",
    "require_last_push_approval",
    "required_checks",
    "dependency_update_provider",
    "delete_branch_on_merge",
    "discussions_enabled",
    "squash_merge_commit_title",
    "squash_merge_commit_message",
}
RULE_ID = re.compile(r"^(?:GR|SEC|WF)-\d{3}$")
RULE_HEADING = re.compile(r"^#{2,3} ((?:GR|SEC|WF)-\d{3}):", re.MULTILINE)
REPOSITORY_TARGET = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
PROFILE_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
BRANCH_CONTROL_IDS = {
    "admin": "branch.admin_bypass_allowed",
    "backend": "branch.enforcement_backend",
    "checks": "branch.required_status_checks",
    "force": "branch.force_pushes_allowed",
    "pull": "branch.pull_request",
}
MANAGED_RULE_TYPES = {"non_fast_forward", "pull_request", "required_status_checks"}
PULL_PARAMETER_FIELDS = {
    "allowed_merge_methods",
    "dismiss_stale_reviews_on_push",
    "dismissal_restriction",
    "require_code_owner_review",
    "require_last_push_approval",
    "required_approving_review_count",
    "required_review_thread_resolution",
    "required_reviewers",
}
STATUS_PARAMETER_FIELDS = {
    "do_not_enforce_on_create",
    "required_status_checks",
    "strict_required_status_checks_policy",
}


class PolicyError(ValueError):
    """Raised when policy cannot safely be resolved."""


class ApplyFailure(PolicyError):
    """Raised with redacted evidence after an apply action fails."""

    def __init__(self, message, evidence):
        super().__init__(message)
        self.evidence = copy.deepcopy(evidence)


def _object(value, fields, label, *, partial=False):
    if type(value) is not dict:
        raise PolicyError(f"{label} must be an object")
    unknown = sorted(set(value) - fields)
    missing = [] if partial else sorted(fields - set(value))
    if unknown or missing:
        details = []
        if unknown:
            details.append(f"unknown fields: {', '.join(unknown)}")
        if missing:
            details.append(f"missing fields: {', '.join(missing)}")
        raise PolicyError(f"{label} has {'; '.join(details)}")


def _schema_version(policy, label):
    if type(policy["schema_version"]) is not int or policy["schema_version"] != SCHEMA_VERSION:
        raise PolicyError(f"{label}.schema_version must be {SCHEMA_VERSION}")


def _validate_rule_refs(refs, known_rule_ids, label):
    if type(refs) is not list or not refs or any(type(ref) is not str for ref in refs):
        raise PolicyError(f"{label}.rule_refs must be a non-empty unique list")
    if len(refs) != len(set(refs)):
        raise PolicyError(f"{label}.rule_refs must be a non-empty unique list")
    invalid = [ref for ref in refs if not RULE_ID.fullmatch(ref)]
    unknown = sorted(set(refs) - known_rule_ids) if not invalid else []
    if invalid or unknown:
        values = invalid or unknown
        raise PolicyError(f"{label}.rule_refs contains invalid or unknown IDs: {values}")


def _validate_branch_name(branch, label):
    if (
        type(branch) is not str
        or not branch
        or branch != branch.strip()
        or len(branch) > 255
        or branch in {"@", ".", ".."}
        or branch.startswith(("-", "/", "."))
        or branch.endswith(("/", ".", ".lock"))
        or "//" in branch
        or ".." in branch
        or "@{" in branch
        or any(part.startswith(".") or part.endswith(".lock") for part in branch.split("/"))
        or any(ord(char) < 32 or ord(char) == 127 or char in " ~^:?*[\\" for char in branch)
    ):
        raise PolicyError(f"{label} is not a safe branch name")


def _validate_required_checks(checks, label):
    if type(checks) is not list or not checks or any(type(check) is not str for check in checks):
        raise PolicyError(f"{label}.required_checks must be a non-empty unique list")
    if len(checks) != len(set(checks)):
        raise PolicyError(f"{label}.required_checks must be a non-empty unique list")
    if any(
        not check.strip()
        or check != check.strip()
        or any(ord(char) < 32 or ord(char) == 127 for char in check)
        for check in checks
    ):
        raise PolicyError(f"{label}.required_checks contains an invalid check name")


def _validate_settings(settings, label):
    _object(settings, SETTING_FIELDS, label)
    _validate_branch_name(settings["target_branch"], f"{label}.target_branch")
    backend = settings["enforcement_backend"]
    if type(backend) is not str or backend not in {"ruleset", "legacy_branch_protection"}:
        raise PolicyError(f"{label}.enforcement_backend is unsupported")
    approvals = settings["required_approvals"]
    if type(approvals) is not int or not 0 <= approvals <= 6:
        raise PolicyError(f"{label}.required_approvals must be an integer from 0 to 6")
    for field in (
        "require_last_push_approval",
        "delete_branch_on_merge",
        "discussions_enabled",
    ):
        if type(settings[field]) is not bool:
            raise PolicyError(f"{label}.{field} must be a boolean")
    if approvals == 0 and settings["require_last_push_approval"]:
        raise PolicyError(f"{label}.require_last_push_approval needs at least one approval")
    _validate_required_checks(settings["required_checks"], label)
    provider = settings["dependency_update_provider"]
    if type(provider) is not str or provider not in {"renovate", "dependabot"}:
        raise PolicyError(f"{label}.dependency_update_provider must select exactly one provider")
    squash_title = settings["squash_merge_commit_title"]
    if type(squash_title) is not str or squash_title not in {
        "PR_TITLE",
        "COMMIT_OR_PR_TITLE",
    }:
        raise PolicyError(f"{label}.squash_merge_commit_title is unsupported")
    squash_message = settings["squash_merge_commit_message"]
    if type(squash_message) is not str or squash_message not in {
        "PR_BODY",
        "COMMIT_MESSAGES",
        "BLANK",
    }:
        raise PolicyError(f"{label}.squash_merge_commit_message is unsupported")


def _profile_chain(profiles):
    if type(profiles) is not list or len(profiles) > MAX_PROFILES:
        raise PolicyError(f"profiles must be a list of at most {MAX_PROFILES} profiles")
    by_id = {}
    for index, profile in enumerate(profiles):
        label = f"profiles[{index}]"
        _object(profile, {"schema_version", "id", "parent", "required_checks"}, label)
        _schema_version(profile, label)
        profile_id = profile["id"]
        parent = profile["parent"]
        if (
            type(profile_id) is not str
            or not PROFILE_ID.fullmatch(profile_id)
            or profile_id == MANAGER
            or type(parent) is not str
            or not PROFILE_ID.fullmatch(parent)
        ):
            raise PolicyError(f"{label} has an invalid id or parent")
        _validate_required_checks(profile["required_checks"], label)
        if profile_id in by_id:
            raise PolicyError(f"profiles contain duplicate id: {profile_id}")
        by_id[profile_id] = copy.deepcopy(profile)
    chain = []
    parent = MANAGER
    remaining = set(by_id)
    while remaining:
        children = sorted(item for item in remaining if by_id[item]["parent"] == parent)
        if len(children) != 1:
            raise PolicyError(f"profiles must form one parent chain rooted at {MANAGER}")
        profile_id = children[0]
        chain.append(by_id[profile_id])
        remaining.remove(profile_id)
        parent = profile_id
    return chain


def _merge_required_checks(*groups):
    return list(dict.fromkeys(check for group in groups for check in group))


def resolve_policy(foundation, repository, known_rule_ids, profiles=None):
    """Validate ordered governance layers and return their effective policy."""
    _object(foundation, {"schema_version", "managed_by", "minimums", "defaults"}, "foundation")
    _schema_version(foundation, "foundation")
    if foundation["managed_by"] != MANAGER:
        raise PolicyError(f"foundation.managed_by must be {MANAGER}")
    _object(foundation["minimums"], set(MINIMUM_CONTRACT), "foundation.minimums")
    for name, (required_value, required_refs) in MINIMUM_CONTRACT.items():
        control = foundation["minimums"][name]
        _object(control, {"value", "rule_refs"}, f"foundation.minimums.{name}")
        if type(control["value"]) is not bool or control["value"] is not required_value:
            raise PolicyError(f"foundation.minimums.{name}.value cannot weaken the foundation")
        _validate_rule_refs(control["rule_refs"], known_rule_ids, f"foundation.minimums.{name}")
        if set(control["rule_refs"]) != required_refs:
            raise PolicyError(f"foundation.minimums.{name}.rule_refs does not match its contract")
    _validate_settings(foundation["defaults"], "foundation.defaults")
    profiles = _profile_chain([] if profiles is None else profiles)

    _object(repository, {"schema_version", "overrides"}, "repository")
    _schema_version(repository, "repository")
    _object(repository["overrides"], SETTING_FIELDS, "repository.overrides", partial=True)
    overrides = copy.deepcopy(repository["overrides"])
    repository_checks = overrides.pop("required_checks", [])
    if "required_checks" in repository["overrides"]:
        _validate_required_checks(repository_checks, "repository.overrides")
    settings = copy.deepcopy(foundation["defaults"])
    settings.update(overrides)
    settings["required_checks"] = _merge_required_checks(
        foundation["defaults"]["required_checks"],
        *(profile["required_checks"] for profile in profiles),
        repository_checks,
    )
    _validate_settings(settings, "resolved.settings")
    return {
        "schema_version": SCHEMA_VERSION,
        "managed_by": MANAGER,
        "minimums": copy.deepcopy(foundation["minimums"]),
        "profiles": profiles,
        "settings": settings,
    }


def _gh_get_json(endpoint, runner, *, optional=False, paginate=False, collection_key=None):
    command = [
        "gh",
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        f"X-GitHub-Api-Version: {API_VERSION}",
    ]
    if paginate:
        command.extend(("--paginate", "--slurp"))
    command.append(endpoint)
    try:
        result = runner(command, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise PolicyError(f"GitHub GET could not run for {endpoint}: {error}") from error
    if result.returncode != 0:
        if optional:
            return None
        raise PolicyError(
            f"GitHub GET failed for {endpoint}; verify gh authentication and repository read access"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise PolicyError(f"GitHub GET returned invalid JSON for {endpoint}") from error
    if paginate:
        if collection_key:
            if type(payload) is not list or any(
                type(page) is not dict or type(page.get(collection_key)) is not list
                for page in payload
            ):
                raise PolicyError(f"GitHub GET returned an invalid paginated response for {endpoint}")
            return [item for page in payload for item in page[collection_key]]
        if type(payload) is not list or any(type(page) is not list for page in payload):
            raise PolicyError(f"GitHub GET returned an invalid paginated response for {endpoint}")
        return [item for page in payload for item in page]
    return payload


def _gh_get_status(endpoint, runner):
    command = [
        "gh",
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        f"X-GitHub-Api-Version: {API_VERSION}",
        "--include",
        endpoint,
    ]
    try:
        result = runner(command, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise PolicyError(f"GitHub GET could not run for {endpoint}") from error
    first_line = result.stdout.splitlines()[0] if result.stdout else ""
    match = re.match(r"^HTTP/\S+\s+(\d{3})\b", first_line)
    if not match:
        raise PolicyError(f"GitHub GET returned no HTTP status for {endpoint}")
    return int(match.group(1))


def _known(value, expected_type):
    return value if type(value) is expected_type else UNKNOWN


def _security_inventory(repository):
    security = repository.get("security_and_analysis")

    def status(name):
        feature = security.get(name) if type(security) is dict else None
        value = feature.get("status") if type(feature) is dict else None
        return value if value in {"enabled", "disabled"} else UNKNOWN

    return {
        "dependabot_security_updates": status("dependabot_security_updates"),
        "push_protection": status("secret_scanning_push_protection"),
        "secret_scanning": status("secret_scanning"),
    }


def _vulnerability_alerts_inventory(repository, admin_access, runner):
    endpoint = f"repos/{repository}/vulnerability-alerts"
    try:
        status = _gh_get_status(endpoint, runner)
    except PolicyError:
        if admin_access is not True:
            return UNKNOWN
        raise
    if status == 204:
        return "enabled"
    if status == 404:
        return "disabled" if admin_access is True else UNKNOWN
    if status == 403:
        return UNKNOWN
    raise PolicyError(f"GitHub GET returned unexpected HTTP status for {endpoint}")


def _private_reporting_inventory(payload):
    enabled = payload.get("enabled") if type(payload) is dict else None
    return "enabled" if enabled is True else "disabled" if enabled is False else UNKNOWN


def _observed_checks(repository, branch, runner):
    commit = branch.get("commit")
    sha = commit.get("sha") if type(commit) is dict else None
    if type(sha) is not str or not re.fullmatch(r"[0-9a-fA-F]{40,64}", sha):
        raise PolicyError("GitHub branch response is missing a valid commit SHA")
    runs = _gh_get_json(
        f"repos/{repository}/commits/{sha}/check-runs?per_page=100",
        runner,
        paginate=True,
        collection_key="check_runs",
    )
    statuses = _gh_get_json(
        f"repos/{repository}/commits/{sha}/statuses?per_page=100",
        runner,
        paginate=True,
    )
    if any(type(run) is not dict or type(run.get("name")) is not str for run in runs):
        raise PolicyError("GitHub check-runs response contains an invalid check name")
    if any(
        type(status) is not dict or type(status.get("context")) is not str
        for status in statuses
    ):
        raise PolicyError("GitHub statuses response contains an invalid context")
    return sorted({run["name"] for run in runs} | {status["context"] for status in statuses})


def _safe_rule_parameters(rule):
    parameters = rule.get("parameters")
    if type(parameters) is not dict:
        return {}
    if rule["type"] == "pull_request":
        return {
            "required_approving_review_count": _known(
                parameters.get("required_approving_review_count"), int
            ),
            "require_last_push_approval": _known(parameters.get("require_last_push_approval"), bool),
        }
    if rule["type"] == "required_status_checks":
        checks = parameters.get("required_status_checks")
        contexts = (
            sorted(
                check["context"]
                for check in checks
                if type(check) is dict and type(check.get("context")) is str
            )
            if type(checks) is list
            and all(type(check) is dict and type(check.get("context")) is str for check in checks)
            else UNKNOWN
        )
        return {
            "contexts": contexts,
            "strict": _known(parameters.get("strict_required_status_checks_policy"), bool),
        }
    return {}


def _update_conditions(detail, unsupported):
    conditions = detail.get("conditions")
    ref_name = conditions.get("ref_name") if type(conditions) is dict else None
    if (
        type(conditions) is not dict
        or set(conditions) != {"ref_name"}
        or type(ref_name) is not dict
        or set(ref_name) != {"exclude", "include"}
    ):
        unsupported.append("invalid_conditions")
        return UNKNOWN
    include = ref_name["include"]
    exclude = ref_name["exclude"]
    if type(include) is not list or type(exclude) is not list or any(
        type(item) is not str for item in include + exclude
    ):
        unsupported.append("invalid_conditions")
        return UNKNOWN
    return {"exclude": sorted(set(exclude)), "include": sorted(set(include))}


def _pull_update_state(parameters, unsupported):
    if type(parameters) is not dict:
        unsupported.append("invalid_pull_request_parameters")
        return UNKNOWN
    if set(parameters) - PULL_PARAMETER_FIELDS:
        unsupported.append("unsupported_pull_request_parameters")
    restriction = parameters.get("dismissal_restriction")
    if restriction not in (None, {}) and not (
        type(restriction) is dict
        and set(restriction) <= {"allowed_actors", "enabled"}
        and restriction.get("enabled") is False
        and restriction.get("allowed_actors") in (None, [])
    ):
        unsupported.append("review_dismissal_restriction")
    if parameters.get("required_reviewers") not in (None, []):
        unsupported.append("required_reviewers")
    methods = parameters.get("allowed_merge_methods")
    if methods is not None and (
        type(methods) is not list
        or not methods
        or any(type(method) is not str or method not in {"merge", "rebase", "squash"} for method in methods)
        or len(methods) != len(set(methods))
    ):
        unsupported.append("invalid_allowed_merge_methods")
        methods = UNKNOWN
    return {
        "allowed_merge_methods": sorted(methods) if type(methods) is list else methods,
        "dismiss_stale_reviews_on_push": _known(
            parameters.get("dismiss_stale_reviews_on_push"), bool
        ),
        "require_code_owner_review": _known(
            parameters.get("require_code_owner_review"), bool
        ),
        "required_review_thread_resolution": _known(
            parameters.get("required_review_thread_resolution"), bool
        ),
    }


def _checks_update_state(parameters, unsupported):
    if type(parameters) is not dict:
        unsupported.append("invalid_status_check_parameters")
        return UNKNOWN
    if set(parameters) - STATUS_PARAMETER_FIELDS:
        unsupported.append("unsupported_status_check_parameters")
    checks = parameters.get("required_status_checks")
    if type(checks) is not list:
        unsupported.append("invalid_required_status_checks")
        return UNKNOWN
    normalized = []
    contexts = set()
    for check in checks:
        context = check.get("context") if type(check) is dict else None
        integration_id = check.get("integration_id") if type(check) is dict else None
        if (
            type(check) is not dict
            or set(check) - {"context", "integration_id"}
            or type(context) is not str
            or not context
            or context in contexts
            or (integration_id is not None and (type(integration_id) is not int or integration_id <= 0))
        ):
            unsupported.append("invalid_required_status_checks")
            return UNKNOWN
        contexts.add(context)
        normalized.append({"context": context, "integration_id": integration_id})
    return sorted(normalized, key=lambda check: check["context"])


def _managed_update_state(detail):
    unsupported = []
    state = {
        "conditions": _update_conditions(detail, unsupported),
        "pull_request": None,
        "required_status_checks": None,
        "rule_types": [],
        "unsupported": unsupported,
    }
    if detail.get("target") != "branch":
        unsupported.append("unsupported_target")
    rules = detail.get("rules")
    if type(rules) is not list:
        unsupported.append("invalid_rules")
        return state
    seen = set()
    for rule in rules:
        rule_type = rule.get("type") if type(rule) is dict else None
        if type(rule_type) is not str or rule_type not in MANAGED_RULE_TYPES:
            unsupported.append("unsupported_rule")
            continue
        if rule_type in seen:
            unsupported.append("duplicate_rule")
            continue
        seen.add(rule_type)
        if rule_type == "pull_request":
            state["pull_request"] = _pull_update_state(rule.get("parameters"), unsupported)
        elif rule_type == "required_status_checks":
            state["required_status_checks"] = _checks_update_state(
                rule.get("parameters"), unsupported
            )
        elif rule.get("parameters") not in (None, {}):
            unsupported.append("unsupported_non_fast_forward_parameters")
    state["rule_types"] = sorted(seen)
    state["unsupported"] = sorted(set(unsupported))
    return state


def _normalize_rules(rules):
    normalized = []
    for rule in rules:
        if type(rule) is not dict or type(rule.get("type")) is not str:
            raise PolicyError("GitHub effective rules response has an invalid rule")
        ruleset_id = rule.get("ruleset_id")
        source = rule.get("ruleset_source")
        source_type = rule.get("ruleset_source_type")
        normalized.append(
            {
                "parameters": _safe_rule_parameters(rule),
                "ruleset_id": _known(ruleset_id, int),
                "source": _known(source, str),
                "source_type": _known(source_type, str),
                "type": rule["type"],
            }
        )
    return sorted(normalized, key=lambda rule: json.dumps(rule, sort_keys=True))


def _ruleset_endpoint(source_type, source, ruleset_id):
    if source_type == "Repository" and REPOSITORY_TARGET.fullmatch(str(source)):
        return f"repos/{source}/rulesets/{ruleset_id}"
    if source_type == "Organization" and re.fullmatch(r"[A-Za-z0-9_.-]+", str(source)):
        return f"orgs/{quote(source, safe='')}/rulesets/{ruleset_id}"
    return None


def _discover_rulesets(repository, rules, runner):
    references = {
        (rule["source_type"], rule["source"], rule["ruleset_id"]): UNKNOWN
        for rule in rules
        if type(rule["ruleset_id"]) is int
    }
    summaries = _gh_get_json(
        f"repos/{repository}/rulesets?includes_parents=false&per_page=100",
        runner,
        paginate=True,
    )
    for summary in summaries:
        if (
            type(summary) is not dict
            or type(summary.get("id")) is not int
            or type(summary.get("source")) is not str
            or summary.get("source_type") != "Repository"
        ):
            raise PolicyError("GitHub repository rulesets response contains an invalid ruleset")
        reference = (summary["source_type"], summary["source"], summary["id"])
        references[reference] = _known(summary.get("name"), str)
    inventory = []
    for reference in sorted(references, key=lambda item: str(item)):
        source_type, source, ruleset_id = reference
        endpoint = _ruleset_endpoint(source_type, source, ruleset_id)
        name = references[reference]
        detail = (
            _gh_get_json(endpoint, runner, optional=True)
            if endpoint and name in {UNKNOWN, MANAGED_RULESET_NAME}
            else None
        )
        if detail is not None and type(detail) is not dict:
            raise PolicyError(f"GitHub ruleset {ruleset_id} response must be an object")
        actors = detail.get("bypass_actors") if detail else None
        resolved_name = _known(detail.get("name"), str) if detail else references[reference]
        item = {
            "has_bypass_actors": bool(actors) if type(actors) is list else UNKNOWN,
            "id": ruleset_id,
            "name": resolved_name,
            "source": source,
            "source_type": source_type,
        }
        if detail and source_type == "Repository" and resolved_name == MANAGED_RULESET_NAME:
            item["update_state"] = _managed_update_state(detail)
        inventory.append(item)
    return inventory


def _legacy_inventory(protected, protection):
    if not protected:
        return {"status": "absent"}
    if protection is None:
        return {"status": UNKNOWN}
    if type(protection) is not dict:
        raise PolicyError("GitHub branch protection response must be an object")

    def enabled(name):
        value = protection.get(name)
        return _known(value.get("enabled"), bool) if type(value) is dict else UNKNOWN

    checks = protection.get("required_status_checks")
    reviews = protection.get("required_pull_request_reviews")
    contexts = checks.get("contexts") if type(checks) is dict else None
    return {
        "allow_force_pushes": enabled("allow_force_pushes"),
        "enforce_admins": enabled("enforce_admins"),
        "required_pull_request_reviews": (
            {
                "require_last_push_approval": _known(reviews.get("require_last_push_approval"), bool),
                "required_approvals": _known(reviews.get("required_approving_review_count"), int),
            }
            if type(reviews) is dict
            else None
        ),
        "required_status_checks": (
            {
                "contexts": (
                    sorted(contexts)
                    if type(contexts) is list and all(type(context) is str for context in contexts)
                    else UNKNOWN
                ),
                "strict": _known(checks.get("strict"), bool),
            }
            if type(checks) is dict
            else None
        ),
        "status": "configured",
    }


def _discover_legacy_protection(repository, branch_path, protected, admin_access, runner):
    if not protected:
        return _legacy_inventory(False, None)
    endpoint = f"repos/{repository}/branches/{branch_path}/protection"
    protection = _gh_get_json(endpoint, runner, optional=True)
    if protection is not None:
        return _legacy_inventory(True, protection)
    if admin_access is not True:
        return _legacy_inventory(True, None)
    try:
        status = _gh_get_status(endpoint, runner)
    except PolicyError:
        return _legacy_inventory(True, None)
    return (
        _legacy_inventory(False, None)
        if status == 404
        else _legacy_inventory(True, None)
    )


def discover_github(repository, branch, runner=None):
    """Read and redact GitHub governance state without making write requests."""
    if (
        type(repository) is not str
        or not REPOSITORY_TARGET.fullmatch(repository)
        or any(part in {".", ".."} for part in repository.split("/"))
    ):
        raise PolicyError("repository target must use OWNER/REPOSITORY format")
    _validate_branch_name(branch, "target branch")
    runner = runner or subprocess.run
    branch_path = quote(branch, safe="")
    repository_data = _gh_get_json(f"repos/{repository}", runner)
    branch_data = _gh_get_json(f"repos/{repository}/branches/{branch_path}", runner)
    rules_data = _gh_get_json(
        f"repos/{repository}/rules/branches/{branch_path}?per_page=100",
        runner,
        paginate=True,
    )
    if type(repository_data) is not dict or type(branch_data) is not dict:
        raise PolicyError("GitHub repository and branch responses must be objects")
    protected = branch_data.get("protected")
    if type(protected) is not bool:
        raise PolicyError("GitHub branch response is missing the protected boolean")
    permissions = repository_data.get("permissions")
    admin_access = permissions.get("admin") if type(permissions) is dict else UNKNOWN
    if type(admin_access) is not bool:
        admin_access = UNKNOWN
    rules = _normalize_rules(rules_data)
    legacy_branch_protection = _discover_legacy_protection(
        repository,
        branch_path,
        protected,
        admin_access,
        runner,
    )
    security = _security_inventory(repository_data)
    security.update(
        {
            "private_vulnerability_reporting": _private_reporting_inventory(
                _gh_get_json(
                    f"repos/{repository}/private-vulnerability-reporting",
                    runner,
                    optional=True,
                )
            ),
            "vulnerability_alerts": _vulnerability_alerts_inventory(
                repository,
                admin_access,
                runner,
            ),
        }
    )
    return {
        "api_version": API_VERSION,
        "branch": {"name": branch, "protected": protected},
        "effective_rules": rules,
        "legacy_branch_protection": legacy_branch_protection,
        "observed_checks": _observed_checks(repository, branch_data, runner),
        "repository": {
            "allow_merge_commit": _known(repository_data.get("allow_merge_commit"), bool),
            "allow_rebase_merge": _known(repository_data.get("allow_rebase_merge"), bool),
            "allow_squash_merge": _known(repository_data.get("allow_squash_merge"), bool),
            "default_branch": _known(repository_data.get("default_branch"), str),
            "delete_branch_on_merge": _known(repository_data.get("delete_branch_on_merge"), bool),
            "full_name": repository,
            "has_discussions": _known(repository_data.get("has_discussions"), bool),
            "squash_merge_commit_message": _known(
                repository_data.get("squash_merge_commit_message"), str
            ),
            "squash_merge_commit_title": _known(
                repository_data.get("squash_merge_commit_title"), str
            ),
        },
        "rulesets": _discover_rulesets(repository, rules, runner),
        "security": security,
    }


def _has_unknown(value):
    if value == UNKNOWN:
        return True
    return type(value) is dict and any(_has_unknown(item) for item in value.values())


def _control(control_id, current, desired, rule_refs=()):
    status = UNKNOWN if _has_unknown(current) else "compliant" if current == desired else "drift"
    return {
        "current": current,
        "desired": desired,
        "id": control_id,
        "rule_refs": sorted(rule_refs),
        "status": status,
    }


def _single_rule(rules, rule_type):
    matches = [rule for rule in rules if rule["type"] == rule_type]
    if len(matches) > 1:
        raise PolicyError(f"managed ruleset contains multiple {rule_type} rules")
    return matches[0] if matches else None


def _branch_desired(policy):
    settings = policy["settings"]
    minimums = policy["minimums"]
    return {
        "admin": (False, minimums["admin_bypass_allowed"]["rule_refs"]),
        "backend": (settings["enforcement_backend"], ()),
        "force": (False, minimums["force_pushes_allowed"]["rule_refs"]),
        "pull": (
            {
                "require_last_push_approval": settings["require_last_push_approval"],
                "required_approvals": settings["required_approvals"],
            },
            minimums["pull_request_required"]["rule_refs"],
        ),
        "checks": (
            sorted(settings["required_checks"]),
            minimums["status_checks_required"]["rule_refs"],
        ),
    }


def _managed_repository_ruleset(inventory):
    repository = inventory["repository"].get("full_name")
    matches = [
        ruleset
        for ruleset in inventory["rulesets"]
        if ruleset["name"] == MANAGED_RULESET_NAME
        and ruleset.get("source_type") == "Repository"
        and type(ruleset.get("source")) is str
        and type(repository) is str
        and ruleset["source"].casefold() == repository.casefold()
    ]
    if len(matches) > 1:
        raise PolicyError(f"multiple repository rulesets use managed name {MANAGED_RULESET_NAME}")
    return matches[0] if matches else None


def _ruleset_branch_controls(policy, inventory):
    desired = _branch_desired(policy)
    managed = _managed_repository_ruleset(inventory)
    uncertain = any(ruleset["name"] == UNKNOWN for ruleset in inventory["rulesets"])
    uncertain = uncertain or any(rule["ruleset_id"] == UNKNOWN for rule in inventory["effective_rules"])
    if not managed:
        current = UNKNOWN if uncertain else None
        values = {name: current for name in desired}
        managed_id = None
    else:
        managed_id = managed["id"]
        rules = [rule for rule in inventory["effective_rules"] if rule["ruleset_id"] == managed_id]
        pull = _single_rule(rules, "pull_request")
        checks = _single_rule(rules, "required_status_checks")
        no_force = _single_rule(rules, "non_fast_forward")
        values = {
            "admin": managed["has_bypass_actors"],
            "backend": "ruleset",
            "checks": checks["parameters"].get("contexts", UNKNOWN) if checks else None,
            "force": False if no_force else True,
            "pull": (
                {
                    "require_last_push_approval": pull["parameters"].get(
                        "require_last_push_approval", UNKNOWN
                    ),
                    "required_approvals": pull["parameters"].get(
                        "required_approving_review_count", UNKNOWN
                    ),
                }
                if pull
                else None
            ),
        }
    controls = [_control(BRANCH_CONTROL_IDS[name], values[name], *desired[name]) for name in desired]
    unmanaged = [rule for rule in inventory["effective_rules"] if rule["ruleset_id"] != managed_id]
    legacy = inventory["legacy_branch_protection"]
    return controls, unmanaged, None if legacy["status"] == "absent" else legacy


def _legacy_branch_controls(policy, inventory):
    desired = _branch_desired(policy)
    legacy = inventory["legacy_branch_protection"]
    if legacy["status"] != "configured":
        current = UNKNOWN if legacy["status"] == UNKNOWN else None
        values = {name: current for name in desired}
    else:
        reviews = legacy["required_pull_request_reviews"]
        checks = legacy["required_status_checks"]
        enforce_admins = legacy["enforce_admins"]
        values = {
            "admin": UNKNOWN if enforce_admins == UNKNOWN else not enforce_admins,
            "backend": "legacy_branch_protection",
            "checks": checks["contexts"] if checks else None,
            "force": legacy["allow_force_pushes"],
            "pull": reviews,
        }
    controls = [_control(BRANCH_CONTROL_IDS[name], values[name], *desired[name]) for name in desired]
    return controls, inventory["effective_rules"], None


def compare_governance(policy, inventory):
    """Return a deterministic, redacted current-versus-desired governance report."""
    required = {
        "branch",
        "effective_rules",
        "legacy_branch_protection",
        "observed_checks",
        "repository",
        "rulesets",
        "security",
    }
    if type(inventory) is not dict or not required <= set(inventory):
        raise PolicyError("GitHub inventory is missing required governance fields")
    settings = policy["settings"]
    if inventory["branch"].get("name") != settings["target_branch"]:
        raise PolicyError("GitHub inventory branch does not match resolved target_branch")
    if settings["enforcement_backend"] == "ruleset":
        controls, unmanaged_rules, unmanaged_legacy = _ruleset_branch_controls(policy, inventory)
    else:
        controls, unmanaged_rules, unmanaged_legacy = _legacy_branch_controls(policy, inventory)
    minimums = policy["minimums"]
    security = inventory["security"]
    observed_checks = inventory["observed_checks"]
    if type(observed_checks) is not list or any(
        type(check) is not str for check in observed_checks
    ):
        raise PolicyError("GitHub inventory observed_checks must be a list of names")
    required_checks = sorted(settings["required_checks"])
    repository = inventory["repository"]
    controls.extend(
        [
            _control(
                "branch.required_status_checks_observed",
                sorted(set(required_checks) & set(observed_checks)),
                required_checks,
                minimums["status_checks_required"]["rule_refs"],
            ),
            _control(
                "repository.merge_strategy",
                {
                    "allow_merge_commit": repository.get("allow_merge_commit", UNKNOWN),
                    "allow_rebase_merge": repository.get("allow_rebase_merge", UNKNOWN),
                    "allow_squash_merge": repository.get("allow_squash_merge", UNKNOWN),
                },
                {
                    "allow_merge_commit": False,
                    "allow_rebase_merge": False,
                    "allow_squash_merge": True,
                },
                minimums["squash_merge_only"]["rule_refs"],
            ),
            _control(
                "repository.delete_branch_on_merge",
                repository.get("delete_branch_on_merge", UNKNOWN),
                settings["delete_branch_on_merge"],
            ),
            _control(
                "repository.discussions_enabled",
                repository.get("has_discussions", UNKNOWN),
                settings["discussions_enabled"],
            ),
            _control(
                "repository.squash_commit_format",
                {
                    "message": repository.get("squash_merge_commit_message", UNKNOWN),
                    "title": repository.get("squash_merge_commit_title", UNKNOWN),
                },
                {
                    "message": settings["squash_merge_commit_message"],
                    "title": settings["squash_merge_commit_title"],
                },
            ),
            _control(
                "security.dependabot_security_updates",
                security.get("dependabot_security_updates", UNKNOWN),
                "enabled" if settings["dependency_update_provider"] == "dependabot" else "disabled",
            ),
            _control(
                "security.push_protection",
                security.get("push_protection", UNKNOWN),
                "enabled",
                minimums["push_protection_enabled"]["rule_refs"],
            ),
            _control(
                "security.secret_scanning",
                security.get("secret_scanning", UNKNOWN),
                "enabled",
                minimums["secret_scanning_enabled"]["rule_refs"],
            ),
            _control(
                "security.private_vulnerability_reporting",
                security.get("private_vulnerability_reporting", UNKNOWN),
                "enabled",
                minimums["private_vulnerability_reporting_enabled"]["rule_refs"],
            ),
            _control(
                "security.vulnerability_alerts",
                security.get("vulnerability_alerts", UNKNOWN),
                "enabled",
                minimums["vulnerability_alerts_enabled"]["rule_refs"],
            ),
        ]
    )
    statuses = {control["status"] for control in controls}
    if unmanaged_legacy and unmanaged_legacy["status"] == UNKNOWN:
        statuses.add(UNKNOWN)
    status = UNKNOWN if UNKNOWN in statuses else "drift" if "drift" in statuses else "compliant"
    return {
        "branch": settings["target_branch"],
        "controls": sorted(controls, key=lambda control: control["id"]),
        "managed_ruleset_name": MANAGED_RULESET_NAME,
        "repository": inventory["repository"].get("full_name", UNKNOWN),
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "unmanaged": {
            "effective_rules": sorted(
                unmanaged_rules, key=lambda rule: json.dumps(rule, sort_keys=True)
            ),
            "legacy_branch_protection": unmanaged_legacy,
        },
    }


def _apply_action(action_id, method, endpoint, body, verify_controls, side_effects):
    return {
        "body": body,
        "endpoint": endpoint,
        "id": action_id,
        "method": method,
        "side_effects": sorted(side_effects),
        "verify_controls": sorted(verify_controls),
    }


def _ruleset_payload(settings, update_state=None):
    integration_ids = {
        check["context"]: check["integration_id"]
        for check in (update_state or {}).get("required_status_checks") or []
    }
    checks = []
    for context in sorted(settings["required_checks"]):
        check = {"context": context}
        if integration_ids.get(context) is not None:
            check["integration_id"] = integration_ids[context]
        checks.append(check)
    current_pull = (update_state or {}).get("pull_request") or {}
    pull_parameters = {
        "dismiss_stale_reviews_on_push": current_pull.get(
            "dismiss_stale_reviews_on_push", False
        ),
        "require_code_owner_review": current_pull.get("require_code_owner_review", False),
        "require_last_push_approval": settings["require_last_push_approval"],
        "required_approving_review_count": settings["required_approvals"],
        "required_review_thread_resolution": True,
    }
    if current_pull.get("allowed_merge_methods") is not None:
        pull_parameters["allowed_merge_methods"] = current_pull["allowed_merge_methods"]
    return {
        "bypass_actors": [],
        "conditions": {
            "ref_name": {
                "exclude": [],
                "include": [f"refs/heads/{settings['target_branch']}"],
            }
        },
        "enforcement": "active",
        "name": MANAGED_RULESET_NAME,
        "rules": [
            {
                "parameters": pull_parameters,
                "type": "pull_request",
            },
            {
                "parameters": {
                    "required_status_checks": checks,
                    "strict_required_status_checks_policy": True,
                },
                "type": "required_status_checks",
            },
            {"type": "non_fast_forward"},
        ],
        "target": "branch",
    }


def _validate_update_state(managed, settings):
    if type(managed.get("id")) is not int or managed["id"] <= 0:
        raise PolicyError("managed repository ruleset has an invalid ID")
    state = managed.get("update_state")
    if type(state) is not dict:
        raise PolicyError("managed repository ruleset detail is unavailable for safe update")
    _object(
        state,
        {"conditions", "pull_request", "required_status_checks", "rule_types", "unsupported"},
        "managed ruleset update state",
    )
    expected = {"exclude": [], "include": [f"refs/heads/{settings['target_branch']}"]}
    if state["conditions"] != expected or state["unsupported"] != []:
        raise PolicyError("managed repository ruleset contains unpreservable constraints")
    rule_types = state["rule_types"]
    if (
        type(rule_types) is not list
        or any(type(rule_type) is not str or rule_type not in MANAGED_RULE_TYPES for rule_type in rule_types)
        or len(rule_types) != len(set(rule_types))
    ):
        raise PolicyError("managed repository ruleset has an invalid rule inventory")
    pull = state["pull_request"]
    if pull is not None:
        _object(
            pull,
            {
                "allowed_merge_methods",
                "dismiss_stale_reviews_on_push",
                "require_code_owner_review",
                "required_review_thread_resolution",
            },
            "managed ruleset pull request state",
        )
        if any(
            type(pull[field]) is not bool
            for field in (
                "dismiss_stale_reviews_on_push",
                "require_code_owner_review",
                "required_review_thread_resolution",
            )
        ):
            raise PolicyError("managed repository ruleset review state is incomplete")
        methods = pull["allowed_merge_methods"]
        if methods is not None and (
            type(methods) is not list
            or not methods
            or any(type(method) is not str or method not in {"merge", "rebase", "squash"} for method in methods)
            or len(methods) != len(set(methods))
        ):
            raise PolicyError("managed repository ruleset merge methods are invalid")
    checks = state["required_status_checks"]
    if ("pull_request" in rule_types) != (pull is not None) or (
        "required_status_checks" in rule_types
    ) != (checks is not None):
        raise PolicyError("managed repository ruleset state does not match its rule inventory")
    if checks is not None and (
        type(checks) is not list
        or any(
            type(check) is not dict
            or set(check) != {"context", "integration_id"}
            or type(check["context"]) is not str
            or not check["context"]
            or (
                check["integration_id"] is not None
                and (type(check["integration_id"]) is not int or check["integration_id"] <= 0)
            )
            for check in checks
        )
        or len(checks) != len({check["context"] for check in checks})
    ):
        raise PolicyError("managed repository ruleset status checks are invalid")
    return state


def _ruleset_apply_action(settings, repository, managed=None):
    update_state = _validate_update_state(managed, settings) if managed else None
    method = "PUT" if managed else "POST"
    endpoint = f"repos/{repository}/rulesets"
    if managed:
        endpoint = f"{endpoint}/{managed['id']}"
    return _apply_action(
        "branch.ruleset",
        method,
        endpoint,
        _ruleset_payload(settings, update_state),
        BRANCH_CONTROL_IDS.values(),
        ["target_branch_merge_requirements_change_immediately"],
    )


def _security_apply_action(controls, repository):
    fields = {}
    side_effects = []
    verify = []
    if controls["security.secret_scanning"]["status"] == "drift":
        fields["secret_scanning"] = {"status": "enabled"}
        side_effects.append("secret_scanning_alerts_may_be_created")
        verify.append("security.secret_scanning")
    if controls["security.push_protection"]["status"] == "drift":
        fields["secret_scanning_push_protection"] = {"status": "enabled"}
        side_effects.append("pushes_containing_detected_secrets_are_rejected")
        verify.append("security.push_protection")
    if not fields:
        return None
    return _apply_action(
        "security.secret_scanning",
        "PATCH",
        f"repos/{repository}",
        {"security_and_analysis": fields},
        verify,
        side_effects,
    )


def _repository_apply_action(controls, settings, repository):
    fields = {}
    side_effects = []
    verify = []
    if controls["repository.merge_strategy"]["status"] == "drift":
        fields.update(
            allow_merge_commit=False,
            allow_rebase_merge=False,
            allow_squash_merge=True,
        )
        side_effects.append("available_pull_request_merge_methods_change_immediately")
        verify.append("repository.merge_strategy")
    if controls["repository.squash_commit_format"]["status"] == "drift":
        fields.update(
            squash_merge_commit_message=settings["squash_merge_commit_message"],
            squash_merge_commit_title=settings["squash_merge_commit_title"],
        )
        side_effects.append("future_squash_commit_defaults_change")
        verify.append("repository.squash_commit_format")
    if controls["repository.discussions_enabled"]["status"] == "drift":
        fields["has_discussions"] = settings["discussions_enabled"]
        side_effects.append("repository_discussions_availability_changes")
        verify.append("repository.discussions_enabled")
    if controls["repository.delete_branch_on_merge"]["status"] == "drift":
        fields["delete_branch_on_merge"] = settings["delete_branch_on_merge"]
        if settings["delete_branch_on_merge"]:
            side_effects.append("future_merged_head_branches_are_deleted")
        verify.append("repository.delete_branch_on_merge")
    if not fields:
        return None
    return _apply_action(
        "repository.settings",
        "PATCH",
        f"repos/{repository}",
        fields,
        verify,
        side_effects,
    )


def _vulnerability_alerts_apply_action(controls, repository):
    control_id = "security.vulnerability_alerts"
    if controls[control_id]["status"] != "drift":
        return None
    return _apply_action(
        control_id,
        "PUT",
        f"repos/{repository}/vulnerability-alerts",
        None,
        [control_id],
        ["dependabot_vulnerability_alerts_may_be_created"],
    )


def _private_reporting_apply_action(controls, repository):
    control_id = "security.private_vulnerability_reporting"
    if controls[control_id]["status"] != "drift":
        return None
    return _apply_action(
        control_id,
        "PUT",
        f"repos/{repository}/private-vulnerability-reporting",
        None,
        [control_id],
        ["private_vulnerability_reports_can_be_submitted"],
    )


def _dependabot_apply_action(controls, settings, repository):
    control_id = "security.dependabot_security_updates"
    if controls[control_id]["status"] != "drift":
        return None
    enabled = settings["dependency_update_provider"] == "dependabot"
    side_effect = (
        "dependabot_security_pull_requests_may_be_created"
        if enabled
        else "dependabot_security_updates_are_disabled"
    )
    return _apply_action(
        control_id,
        "PUT" if enabled else "DELETE",
        f"repos/{repository}/automated-security-fixes",
        None,
        [control_id],
        [side_effect],
    )


def build_apply_actions(policy, inventory):
    """Build deterministic GitHub write requests without executing them."""
    report = compare_governance(policy, inventory)
    repository = report["repository"]
    if type(repository) is not str or not REPOSITORY_TARGET.fullmatch(repository):
        raise PolicyError("GitHub inventory repository is not a safe write target")
    controls = {control["id"]: control for control in report["controls"]}
    if report["status"] == UNKNOWN:
        raise PolicyError("apply requires a complete governance audit without unknown controls")
    observed = controls["branch.required_status_checks_observed"]
    if observed["status"] != "compliant":
        raise PolicyError("apply requires every desired status check on the target branch head")

    settings = policy["settings"]
    actions = []
    security_action = _security_apply_action(controls, repository)
    if security_action:
        actions.append(security_action)
    for action in (
        _vulnerability_alerts_apply_action(controls, repository),
        _private_reporting_apply_action(controls, repository),
    ):
        if action:
            actions.append(action)
    repository_action = _repository_apply_action(controls, settings, repository)
    if repository_action:
        actions.append(repository_action)
    branch_drift = any(
        controls[control_id]["status"] == "drift"
        for control_id in BRANCH_CONTROL_IDS.values()
    )
    if branch_drift:
        if settings["enforcement_backend"] != "ruleset":
            raise PolicyError("legacy branch protection apply actions are not implemented")
        managed = _managed_repository_ruleset(inventory)
        actions.append(_ruleset_apply_action(settings, repository, managed))
    dependabot_action = _dependabot_apply_action(controls, settings, repository)
    if dependabot_action:
        actions.append(dependabot_action)
    return {
        "actions": actions,
        "before_status": report["status"],
        "repository": repository,
        "schema_version": SCHEMA_VERSION,
        "status": "ready" if actions else "compliant",
        "target_branch": settings["target_branch"],
    }


def _gh_write_action(action, runner):
    command = [
        "gh",
        "api",
        "--method",
        action["method"],
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        f"X-GitHub-Api-Version: {API_VERSION}",
        action["endpoint"],
    ]
    arguments = {
        "capture_output": True,
        "text": True,
        "timeout": 30,
        "check": False,
    }
    if action["body"] is not None:
        command.extend(("--input", "-"))
        arguments["input"] = json.dumps(action["body"], separators=(",", ":"), sort_keys=True)
    try:
        result = runner(command, **arguments)
    except (OSError, subprocess.SubprocessError) as error:
        raise PolicyError(f"GitHub write could not run for action {action['id']}") from error
    if result.returncode != 0:
        raise PolicyError(
            f"GitHub write failed for action {action['id']}; verify gh authentication "
            "and repository administration access"
        )


def _raise_apply_failure(evidence, action_id, phase, message):
    evidence.update(
        {
            "error": message,
            "failed_action": action_id,
            "failure_phase": phase,
            "status": "failed",
        }
    )
    raise ApplyFailure(message, evidence)


def _verify_action(action, report):
    controls = {control["id"]: control for control in report["controls"]}
    return all(
        controls.get(control_id, {}).get("status") == "compliant"
        for control_id in action["verify_controls"]
    )


def execute_apply(policy, inventory, confirmed_repository, runner=None, discoverer=None):
    """Apply one planned action at a time and verify each action by read-back."""
    plan = build_apply_actions(policy, inventory)
    if confirmed_repository != plan["repository"]:
        raise PolicyError("apply repository confirmation must exactly match the planned target")
    runner = runner or subprocess.run
    discoverer = discoverer or discover_github
    before = compare_governance(policy, inventory)
    evidence = {
        "after": before,
        "attempted_actions": [],
        "before": before,
        "repository": plan["repository"],
        "schema_version": SCHEMA_VERSION,
        "status": "compliant" if not plan["actions"] else "applying",
        "target_branch": plan["target_branch"],
        "verified_actions": [],
    }
    while plan["actions"]:
        action = plan["actions"][0]
        if action["id"] in evidence["attempted_actions"]:
            _raise_apply_failure(
                evidence,
                action["id"],
                "replanning",
                f"action {action['id']} still requires change after verification",
            )
        evidence["attempted_actions"].append(action["id"])
        try:
            _gh_write_action(action, runner)
        except PolicyError as error:
            _raise_apply_failure(evidence, action["id"], "write", str(error))
        try:
            updated = discoverer(
                plan["repository"],
                plan["target_branch"],
                runner=runner,
            )
        except PolicyError:
            _raise_apply_failure(
                evidence,
                action["id"],
                "read_back",
                f"GitHub read-back failed after action {action['id']}",
            )
        try:
            evidence["after"] = compare_governance(policy, updated)
        except PolicyError:
            _raise_apply_failure(
                evidence,
                action["id"],
                "verification",
                f"GitHub read-back could not be compared after action {action['id']}",
            )
        if not _verify_action(action, evidence["after"]):
            _raise_apply_failure(
                evidence,
                action["id"],
                "verification",
                f"action {action['id']} did not reach compliant state",
            )
        evidence["verified_actions"].append(action["id"])
        try:
            plan = build_apply_actions(policy, updated)
        except PolicyError:
            _raise_apply_failure(
                evidence,
                action["id"],
                "replanning",
                f"remaining actions could not be replanned after action {action['id']}",
            )
        if (
            plan["repository"] != evidence["repository"]
            or plan["target_branch"] != evidence["target_branch"]
        ):
            _raise_apply_failure(
                evidence,
                action["id"],
                "replanning",
                "apply target changed during read-back",
            )
    if evidence["after"]["status"] != "compliant":
        _raise_apply_failure(
            evidence,
            "final_audit",
            "verification",
            "apply completed its actions but the final audit is not compliant",
        )
    evidence["status"] = "compliant"
    return evidence


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PolicyError(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def _load_json(path):
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle, object_pairs_hook=_reject_duplicate_keys)
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError(f"cannot read policy {path}: {error}") from error


def _load_profiles(root):
    try:
        root = Path(root).resolve(strict=True)
    except OSError as error:
        raise PolicyError("cannot resolve repository root for profiles") from error
    directory = root / PROFILE_DIRECTORY
    try:
        if directory.is_symlink():
            raise PolicyError(f"profile directory must not use symlinks: {directory}")
        if not directory.exists():
            return []
        if directory.resolve(strict=True) != directory or not directory.is_dir():
            raise PolicyError(f"profile directory must not use symlinks: {directory}")
        paths = sorted(directory.glob("*.json"))
        if len(paths) > MAX_PROFILES:
            raise PolicyError(f"profile directory contains more than {MAX_PROFILES} profiles")
        for path in paths:
            if path.resolve(strict=True) != path or not path.is_file():
                raise PolicyError(f"profile must be a regular file without symlinks: {path}")
    except OSError as error:
        raise PolicyError(f"cannot read profile directory: {directory}") from error
    return [_load_json(path) for path in paths]


def _known_rule_ids(root):
    ids = set()
    for path in sorted((root / ".ai").glob("*.md")):
        ids.update(RULE_HEADING.findall(path.read_text(encoding="utf-8")))
    return ids


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "plan", "audit", "apply"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--foundation", type=Path)
    parser.add_argument("--repository", type=Path)
    parser.add_argument("--repo", help="GitHub repository in OWNER/REPOSITORY form")
    parser.add_argument("--confirm-repo", help="exact repository confirmation required by apply")
    args = parser.parse_args(argv)
    if args.command in {"plan", "audit", "apply"} and not args.repo:
        parser.error("--repo is required for plan, audit, and apply")
    if args.command == "apply" and args.confirm_repo != args.repo:
        parser.error("--confirm-repo must exactly match --repo for apply")
    root = args.root.resolve()
    foundation = args.foundation or root / ".github/governance/foundation.json"
    repository = args.repository or root / ".github/governance/repository.json"
    try:
        resolved = resolve_policy(
            _load_json(foundation),
            _load_json(repository),
            _known_rule_ids(root),
            _load_profiles(root),
        )
        if args.command == "validate":
            report = resolved
        else:
            inventory = discover_github(
                args.repo,
                resolved["settings"]["target_branch"],
            )
            report = (
                execute_apply(resolved, inventory, args.confirm_repo)
                if args.command == "apply"
                else compare_governance(resolved, inventory)
            )
    except ApplyFailure as error:
        print(json.dumps(error.evidence, indent=2, sort_keys=True))
        print(f"governance apply error: {error}", file=sys.stderr)
        return 2
    except PolicyError as error:
        print(f"governance policy error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if args.command == "audit" and report["status"] != "compliant" else 0


if __name__ == "__main__":
    raise SystemExit(main())

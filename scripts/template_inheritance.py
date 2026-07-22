#!/usr/bin/env python3
"""Validate and plan local template inheritance defined by ADR-0004."""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


SCHEMA_VERSION = 1
MANIFEST_PATH = ".github/inheritance/manifest.json"
TEMPLATE_SYNC_IGNORE_PATH = ".templatesyncignore"
MAX_CONTRACT_BYTES = 1_000_000
MAX_OWNERSHIP_ROOTS = 1_000
MAX_FIRST_PARENT_COMMITS = 100_000
MAX_CHANGED_PATHS = 1_000
REPOSITORY_TARGET = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
COMMIT_ID = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_PROTECTED_PATHS = {
    ".gitignore",
    ".github/governance/repository.json",
    ".github/inheritance/manifest.json",
    ".github/workflows/template-sync.yml",
    ".templatesyncignore",
}
REQUIRED_TEMPLATE_SYNC_IGNORES = {".github/workflows/"}


class InheritanceError(ValueError):
    pass


def _object(value, fields, label):
    if type(value) is not dict:
        raise InheritanceError(f"{label} must be an object")
    unknown = sorted(set(value) - fields)
    missing = sorted(fields - set(value))
    if unknown or missing:
        details = []
        if unknown:
            details.append(f"unknown fields: {', '.join(unknown)}")
        if missing:
            details.append(f"missing fields: {', '.join(missing)}")
        raise InheritanceError(f"{label} has {'; '.join(details)}")


def _repository(value, label):
    if type(value) is not str or not REPOSITORY_TARGET.fullmatch(value):
        raise InheritanceError(f"{label} must be OWNER/REPOSITORY")
    return value


def _ownership_root(value, label, *, file_only=False):
    if type(value) is not str or not value or value != value.strip() or len(value) > 1_024:
        raise InheritanceError(f"{label} must be a safe repository-relative ownership root")
    is_directory = value.endswith("/")
    body = value[:-1] if is_directory else value
    parts = body.split("/")
    if (
        not body
        or body.startswith("/")
        or (file_only and is_directory)
        or any(part in {"", ".", "..", ".git"} for part in parts)
        or any(char in "*?[]\\" or ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise InheritanceError(f"{label} must be a safe repository-relative ownership root")
    return value


def _branch(value, label):
    try:
        _ownership_root(value, label, file_only=True)
    except InheritanceError as error:
        raise InheritanceError(f"{label} is not a safe branch name") from error
    if (
        len(value) > 255
        or value == "@"
        or value.startswith(("-", "."))
        or value.endswith((".", ".lock"))
        or ".." in value
        or "@{" in value
        or any(part.startswith(".") or part.endswith(".lock") for part in value.split("/"))
        or any(char in " ~^:" for char in value)
    ):
        raise InheritanceError(f"{label} is not a safe branch name")
    return value


def _ownership_roots(value, label):
    if type(value) is not list or not value or len(value) > MAX_OWNERSHIP_ROOTS:
        raise InheritanceError(f"{label} must be a non-empty unique list of ownership roots")
    roots = [_ownership_root(root, f"{label}[{index}]") for index, root in enumerate(value)]
    if len(roots) != len(set(roots)):
        raise InheritanceError(f"{label} must be a non-empty unique list of ownership roots")
    return roots


def _overlaps(left, right):
    return left == right or (left.endswith("/") and right.startswith(left)) or (
        right.endswith("/") and left.startswith(right)
    )


def _reject_overlaps(roots, label):
    for index, left in enumerate(roots):
        for right in roots[index + 1 :]:
            if _overlaps(left, right):
                raise InheritanceError(f"{label} ownership roots overlap: {left}, {right}")


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise InheritanceError(f"contract JSON contains duplicate key: {key}")
        value[key] = item
    return value


def _read_json(root, relative_path):
    candidate = root / relative_path
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise InheritanceError(f"{relative_path} must be a file inside the repository root") from error
    if resolved != candidate:
        raise InheritanceError(f"{relative_path} must not use a symlink")
    if not resolved.is_relative_to(root):
        raise InheritanceError(f"{relative_path} must be a file inside the repository root")
    if not resolved.is_file():
        raise InheritanceError(f"{relative_path} must be a file inside the repository root")
    try:
        if resolved.stat().st_size > MAX_CONTRACT_BYTES:
            raise InheritanceError(f"{relative_path} exceeds {MAX_CONTRACT_BYTES} bytes")
        return json.loads(resolved.read_text(encoding="utf-8"), object_pairs_hook=_unique_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise InheritanceError(f"{relative_path} must contain valid UTF-8 JSON") from error


def _read_template_sync_ignore(root):
    candidate = root / TEMPLATE_SYNC_IGNORE_PATH
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise InheritanceError(
            f"{TEMPLATE_SYNC_IGNORE_PATH} must be a file inside the repository root"
        ) from error
    if resolved != candidate or not resolved.is_relative_to(root) or not resolved.is_file():
        raise InheritanceError(
            f"{TEMPLATE_SYNC_IGNORE_PATH} must be a non-symlink file inside the repository root"
        )
    try:
        if resolved.stat().st_size > MAX_CONTRACT_BYTES:
            raise InheritanceError(f"{TEMPLATE_SYNC_IGNORE_PATH} exceeds {MAX_CONTRACT_BYTES} bytes")
        lines = resolved.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise InheritanceError(f"{TEMPLATE_SYNC_IGNORE_PATH} must contain valid UTF-8 text") from error

    positive = []
    exceptions = []
    for line_number, line in enumerate(lines, start=1):
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        destination = exceptions if entry.startswith(":!") else positive
        root_entry = entry[2:] if destination is exceptions else entry
        if root_entry.endswith("/**"):
            root_entry = root_entry[:-2]
        try:
            destination.append(
                _ownership_root(root_entry, f"{TEMPLATE_SYNC_IGNORE_PATH}:{line_number}")
            )
        except InheritanceError as error:
            raise InheritanceError(
                f"{TEMPLATE_SYNC_IGNORE_PATH}:{line_number} must be a literal path, "
                "directory, directory/**, or :! exception"
            ) from error
    return positive, exceptions


def _covers(outer, inner):
    return outer == inner or (outer.endswith("/") and inner.startswith(outer))


def _validate_template_sync_ignore(root, protected):
    positive, exceptions = _read_template_sync_ignore(root)
    required = sorted(set(protected) | REQUIRED_TEMPLATE_SYNC_IGNORES)
    missing = sorted(
        path for path in required if not any(_covers(entry, path) for entry in positive)
    )
    if missing:
        raise InheritanceError(f"template sync ignore is missing protected paths: {missing}")
    unsafe_exceptions = sorted(
        exception
        for exception in exceptions
        if any(_overlaps(exception, protected_root) for protected_root in required)
    )
    if unsafe_exceptions:
        raise InheritanceError(
            f"template sync exception re-includes protected paths: {unsafe_exceptions}"
        )
    return {
        "ignore_file": TEMPLATE_SYNC_IGNORE_PATH,
        "required": required,
    }


def validate_inheritance(root):
    """Validate manifest, lock, and exclusive path ownership without external I/O."""
    try:
        repository_root = Path(root).resolve(strict=True)
    except OSError as error:
        raise InheritanceError("repository root must exist") from error
    if not repository_root.is_dir():
        raise InheritanceError("repository root must be a directory")

    manifest = _read_json(repository_root, MANIFEST_PATH)
    _object(manifest, {"schema_version", "parent", "lock_file", "inherited_paths", "protected_paths"}, "manifest")
    if type(manifest["schema_version"]) is not int or manifest["schema_version"] != SCHEMA_VERSION:
        raise InheritanceError(f"manifest.schema_version must be {SCHEMA_VERSION}")
    _object(manifest["parent"], {"repository", "branch"}, "manifest.parent")
    parent_repository = _repository(manifest["parent"]["repository"], "manifest.parent.repository")
    parent_branch = _branch(manifest["parent"]["branch"], "manifest.parent.branch")
    lock_file = _ownership_root(manifest["lock_file"], "manifest.lock_file", file_only=True)
    inherited = _ownership_roots(manifest["inherited_paths"], "manifest.inherited_paths")
    protected = _ownership_roots(manifest["protected_paths"], "manifest.protected_paths")

    _reject_overlaps(inherited, "manifest.inherited_paths")
    _reject_overlaps(protected, "manifest.protected_paths")
    for inherited_root in inherited:
        for protected_root in protected:
            if _overlaps(inherited_root, protected_root):
                raise InheritanceError(
                    "inherited and protected ownership roots overlap: "
                    f"{inherited_root}, {protected_root}"
                )

    required = REQUIRED_PROTECTED_PATHS | {lock_file}
    missing = sorted(path for path in required if not any(_overlaps(root, path) for root in protected))
    if missing:
        raise InheritanceError(f"manifest is missing required protected paths: {missing}")

    template_sync = _validate_template_sync_ignore(repository_root, protected)

    lock = _read_json(repository_root, lock_file)
    _object(lock, {"schema_version", "parent"}, "lock")
    if type(lock["schema_version"]) is not int or lock["schema_version"] != SCHEMA_VERSION:
        raise InheritanceError(f"lock.schema_version must be {SCHEMA_VERSION}")
    _object(lock["parent"], {"repository", "commit"}, "lock.parent")
    locked_repository = _repository(lock["parent"]["repository"], "lock.parent.repository")
    commit = lock["parent"]["commit"]
    if locked_repository != parent_repository:
        raise InheritanceError("lock.parent.repository must match manifest.parent.repository")
    if type(commit) is not str or not COMMIT_ID.fullmatch(commit) or commit == "0" * 40:
        raise InheritanceError("lock.parent.commit must be a full non-zero lowercase commit ID")

    return {
        "schema_version": SCHEMA_VERSION,
        "parent": {"repository": parent_repository, "branch": parent_branch, "commit": commit},
        "lock_file": lock_file,
        "ownership": {"inherited": sorted(inherited), "protected": sorted(protected)},
        "template_sync": template_sync,
    }


def _git(root, arguments, operation):
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            capture_output=True,
            check=False,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise InheritanceError(f"parent Git {operation} could not run") from error
    if result.returncode != 0:
        raise InheritanceError(f"parent Git {operation} failed; refresh the local parent checkout")
    return result.stdout


def _github_repository(remote_url):
    for prefix in ("https://github.com/", "git@github.com:", "ssh://git@github.com/"):
        if remote_url.startswith(prefix):
            repository = remote_url[len(prefix) :]
            if repository.endswith(".git"):
                repository = repository[:-4]
            if REPOSITORY_TARGET.fullmatch(repository):
                return repository
    raise InheritanceError("parent origin must be a credential-free GitHub repository URL")


def _parent_root(parent_root):
    try:
        root = Path(parent_root).resolve(strict=True)
    except OSError as error:
        raise InheritanceError("parent root must exist") from error
    if not root.is_dir():
        raise InheritanceError("parent root must be a directory")
    top_level = Path(_git(root, ["rev-parse", "--show-toplevel"], "root discovery").strip()).resolve()
    if top_level != root:
        raise InheritanceError("parent root must be the Git worktree top level")
    return root


def _next_parent_commit(parent_root, contract):
    remote = _git(parent_root, ["remote", "get-url", "origin"], "origin discovery").strip()
    if _github_repository(remote).casefold() != contract["parent"]["repository"].casefold():
        raise InheritanceError("parent origin does not match manifest.parent.repository")
    branch = contract["parent"]["branch"]
    target = _git(
        parent_root,
        ["rev-parse", "--verify", f"refs/remotes/origin/{branch}^{{commit}}"],
        "remote branch resolution",
    ).strip()
    if not COMMIT_ID.fullmatch(target):
        raise InheritanceError("parent remote branch did not resolve to a full commit ID")
    history = _git(
        parent_root,
        ["rev-list", "--first-parent", f"--max-count={MAX_FIRST_PARENT_COMMITS + 1}", target],
        "first-parent history read",
    ).splitlines()
    locked = contract["parent"]["commit"]
    if locked not in history:
        suffix = " within the supported history window" if len(history) > MAX_FIRST_PARENT_COMMITS else ""
        raise InheritanceError(f"locked commit is not on the remote branch first-parent history{suffix}")
    index = history.index(locked)
    return target, None if index == 0 else history[index - 1]


def _changed_paths(parent_root, locked, candidate):
    output = _git(
        parent_root,
        ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", locked, candidate],
        "candidate diff read",
    )
    paths = sorted(path for path in output.split("\0") if path)
    if len(paths) > MAX_CHANGED_PATHS:
        raise InheritanceError(f"candidate commit changes more than {MAX_CHANGED_PATHS} paths")
    for index, path in enumerate(paths):
        _ownership_root(path, f"parent changed path[{index}]", file_only=True)
    return paths


def _path_owner(path, ownership):
    for owner in ("inherited", "protected"):
        if any(root == path or (root.endswith("/") and path.startswith(root)) for root in ownership[owner]):
            return owner
    return "unowned"


def _parent_entry(parent_root, candidate, path):
    output = _git(parent_root, ["ls-tree", "-z", candidate, "--", path], "candidate tree read")
    if not output:
        return None
    try:
        metadata, actual_path = output.rstrip("\0").split("\t", 1)
        mode, object_type, object_id = metadata.split(" ")
    except ValueError as error:
        raise InheritanceError(f"parent path has an invalid tree entry: {path}") from error
    if actual_path != path or object_type != "blob" or mode not in {"100644", "100755"}:
        raise InheritanceError(f"parent path must be a regular file: {path}")
    return object_id, mode == "100755"


def _child_entry(child_root, parent_root, path):
    current = child_root
    for part in path.split("/"):
        current /= part
        if current.is_symlink():
            raise InheritanceError(f"inherited child path must not use a symlink: {path}")
        if not current.exists():
            return None
    if not current.is_file():
        raise InheritanceError(f"inherited child path must be a regular file: {path}")
    object_id = _git(parent_root, ["hash-object", "--no-filters", "--", str(current)], "child hash").strip()
    return object_id, bool(current.stat().st_mode & 0o111)


def plan_inheritance(root, parent_root):
    """Plan one first-parent commit without modifying either worktree."""
    contract = validate_inheritance(root)
    child_root = Path(root).resolve(strict=True)
    parent_root = _parent_root(parent_root)
    target, candidate = _next_parent_commit(parent_root, contract)
    changes = {name: [] for name in ("add", "modify", "candidate_delete", "already_current")}
    skipped = {name: [] for name in ("protected", "unowned")}
    if candidate:
        for path in _changed_paths(parent_root, contract["parent"]["commit"], candidate):
            owner = _path_owner(path, contract["ownership"])
            if owner != "inherited":
                skipped[owner].append(path)
                continue
            parent_entry = _parent_entry(parent_root, candidate, path)
            child_entry = _child_entry(child_root, parent_root, path)
            if parent_entry is None:
                operation = "candidate_delete" if child_entry else "already_current"
            elif child_entry is None:
                operation = "add"
            else:
                operation = "already_current" if child_entry == parent_entry else "modify"
            changes[operation].append(path)
    counts = {name: len(paths) for name, paths in {**changes, **skipped}.items()}
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "changes" if candidate else "up_to_date",
        "parent": {
            "repository": contract["parent"]["repository"],
            "branch": contract["parent"]["branch"],
            "locked_commit": contract["parent"]["commit"],
            "target_commit": target,
            "candidate_commit": candidate,
        },
        "changes": changes,
        "skipped": skipped,
        "summary": {**counts, "total": sum(counts.values())},
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="validate contract")
    validate.add_argument("--root", type=Path, default=Path("."), help="child repository root")
    plan = commands.add_parser("plan", help="plan the next parent commit")
    plan.add_argument("--root", type=Path, default=Path("."), help="child repository root")
    plan.add_argument("--parent-root", type=Path, required=True, help="local parent Git worktree")
    args = parser.parse_args(argv)
    try:
        report = validate_inheritance(args.root) if args.command == "validate" else plan_inheritance(args.root, args.parent_root)
    except InheritanceError as error:
        print(f"inheritance error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

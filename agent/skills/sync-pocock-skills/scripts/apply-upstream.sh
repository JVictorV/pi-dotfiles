#!/usr/bin/env bash
# apply-upstream.sh — Copy upstream skill files then re-apply patches and local overrides.
#
# Usage:
#   bash apply-upstream.sh <skill_name> <upstream_skill_dir> <skills_dir> <patches_dir>
#
# Copies all files from the upstream skill dir into our installed skill dir,
# applies any patches we have for this skill, then applies configured local
# frontmatter overrides from patches/local-overrides.json.

set -euo pipefail

SKILL_NAME="${1:?Usage: apply-upstream.sh <skill_name> <upstream_dir> <skills_dir> <patches_dir>}"
UPSTREAM_SKILL_DIR="${2:?}"
SKILLS_DIR="${3:?}"
PATCHES_DIR="${4:?}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OVERRIDES_SCRIPT="$SCRIPT_DIR/apply-frontmatter-overrides.py"

TARGET_DIR="$SKILLS_DIR/$SKILL_NAME"

if [[ ! -d "$UPSTREAM_SKILL_DIR" ]]; then
  echo "ERROR: upstream dir not found: $UPSTREAM_SKILL_DIR"
  exit 1
fi

# Build the complete replacement beside the installed skills. A patch conflict
# must not leave a partially updated skill or .orig/.rej artifacts behind.
mkdir -p "$SKILLS_DIR"
STAGE_ROOT=$(mktemp -d "$SKILLS_DIR/.${SKILL_NAME}.sync.XXXXXX")
STAGED_DIR="$STAGE_ROOT/staged"
PREVIOUS_DIR="$STAGE_ROOT/previous"
cleanup() {
  status=$?
  trap - EXIT
  if [[ -e "$PREVIOUS_DIR" && ! -e "$TARGET_DIR" ]]; then
    if ! mv "$PREVIOUS_DIR" "$TARGET_DIR"; then
      echo "ERROR: failed to restore interrupted $SKILL_NAME installation; recovery copy retained at $PREVIOUS_DIR" >&2
      exit 1
    fi
  fi
  rm -rf "$STAGE_ROOT"
  exit "$status"
}
trap cleanup EXIT

# Copy upstream files into staging.
echo "Copying upstream $SKILL_NAME..."
mkdir -p "$STAGED_DIR"
rsync -a --delete "$UPSTREAM_SKILL_DIR/" "$STAGED_DIR/"

# Apply patches only to the staged copy.
applied=0
failed=0
for patch_file in "$PATCHES_DIR"/"${SKILL_NAME}"__*.patch; do
  [[ -f "$patch_file" ]] || continue
  patch_basename=$(basename "$patch_file")
  # Derive the target file from the patch name
  # Format: skillname__path__to__file.ext.patch
  rel_path="${patch_basename#"${SKILL_NAME}"__}"
  rel_path="${rel_path%.patch}"
  rel_path="${rel_path//__//}"  # Convert __ back to /
  target_file="$STAGED_DIR/$rel_path"

  if [[ ! -f "$target_file" ]]; then
    echo "  SKIP: $rel_path (file no longer exists)"
    continue
  fi

  if patch --quiet --forward --no-backup-if-mismatch "$target_file" "$patch_file" >/dev/null 2>&1; then
    echo "  PATCHED: $rel_path"
    applied=$((applied + 1))
  else
    echo "  CONFLICT: $rel_path — patch did not apply cleanly"
    failed=$((failed + 1))
  fi
done

if [[ "$failed" -gt 0 ]]; then
  echo "Result: $applied patched, $failed conflicts"
  exit "$failed"
fi

# Apply local frontmatter overrides after patches so they are independent of
# upstream text changes and do not need one-line patch files.
if [[ -f "$STAGED_DIR/SKILL.md" && -f "$OVERRIDES_SCRIPT" ]]; then
  python3 "$OVERRIDES_SCRIPT" "$SKILL_NAME" "$STAGED_DIR/SKILL.md" "$PATCHES_DIR"
fi

# Replace only after the entire staged skill is valid. Keep the old directory
# beside it until the new directory has been moved into place.
if [[ -e "$TARGET_DIR" ]]; then
  mv "$TARGET_DIR" "$PREVIOUS_DIR"
fi
if ! mv "$STAGED_DIR" "$TARGET_DIR"; then
  [[ ! -e "$PREVIOUS_DIR" ]] || mv "$PREVIOUS_DIR" "$TARGET_DIR"
  echo "ERROR: failed to install staged $SKILL_NAME" >&2
  exit 1
fi
rm -rf "$PREVIOUS_DIR"

echo "Result: $applied patched, 0 conflicts"

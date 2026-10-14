#!/usr/bin/env bash
# Puts the two portfolio repositories beside this one, where the parity tests look for them
# (../sameer-3d-portfolio and ../portfolio), so those tests run instead of skipping.
#
# Both repositories are public, so no credential is needed. For each one it uses the branch
# with the same name as the branch under test when that branch exists there, and `main`
# otherwise. That is what lets a change that spans the three repositories be tested as one:
# open branches of the same name in each and CI pairs them up.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parent="$(dirname "$here")"
branch="${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-main}}"

for repo in portfolio sameer-3d-portfolio; do
  url="https://github.com/S-MOHAMMAD-SYED-SAMEER/${repo}.git"
  ref=main
  if [ "$branch" != "main" ] && git ls-remote --exit-code --heads "$url" "refs/heads/${branch}" >/dev/null 2>&1; then
    ref="$branch"
  fi
  echo "${repo}: using ${ref}"
  rm -rf "${parent:?}/${repo}"
  git clone --quiet --depth 1 --branch "$ref" "$url" "${parent}/${repo}"
done

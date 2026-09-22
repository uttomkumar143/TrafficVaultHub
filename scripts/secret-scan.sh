#!/usr/bin/env bash
# Lightweight secret scan for the TrafficVaultHub repository.
# Scans tracked + untracked (non-ignored) files for common credential patterns.
# Exit code 0 = clean, 1 = potential secret found (review output).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'                        # OpenAI-style keys
  'ghp_[A-Za-z0-9]{30,}'                       # GitHub PAT
  'github_pat_[A-Za-z0-9_]{30,}'               # GitHub fine-grained PAT
  'AKIA[0-9A-Z]{16}'                           # AWS access key
  'xox[baprs]-[A-Za-z0-9-]{10,}'               # Slack tokens
  'AIza[0-9A-Za-z_-]{30,}'                     # Google API key
  '-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY'
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}'  # JWT
  '(api[_-]?key|secret|token|password|passwd)["'"'"']?\s*[:=]\s*["'"'"'][A-Za-z0-9/+_=-]{16,}["'"'"']'
  'CLOUDFLARE_API_TOKEN\s*=\s*[A-Za-z0-9_-]{20,}'
)

FILES=$(git ls-files --cached --others --exclude-standard | grep -v -E '(^|/)(package-lock\.json|\.gitkeep)$' || true)

FOUND=0
for p in "${PATTERNS[@]}"; do
  # shellcheck disable=SC2086
  if echo "$FILES" | xargs -r grep -nIE -- "$p" 2>/dev/null; then
    FOUND=1
  fi
done

# Tracked filenames that must never be committed
if git ls-files | grep -E '(^|/)(\.env|\.env\.[^e].*|\.dev\.vars)$' ; then
  echo "ERROR: environment/secret file is tracked by git"
  FOUND=1
fi

if [ "$FOUND" -eq 0 ]; then
  echo "SECRET SCAN: CLEAN ($(echo "$FILES" | grep -c . ) files checked)"
  exit 0
else
  echo "SECRET SCAN: POTENTIAL SECRETS FOUND — review above"
  exit 1
fi

#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 5 ]; then
  echo "Usage: $0 <agent> <summary> <changes> <risks> <next>"
  echo "Example:"
  echo "  $0 codex \"Done A\" \"Edited docs/X.md\" \"No tests\" \"Claude review\""
  exit 1
fi

agent="$1"
summary="$2"
changes="$3"
risks="$4"
next="$5"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
log_file="$repo_root/bridge/LOG.md"
ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat >> "$log_file" <<EOF
## ${ts} | ${agent}
### Summary
- ${summary}

### Changes
- ${changes}

### Risks
- ${risks}

### Next
- ${next}

---
EOF

echo "Added handover entry to $log_file"

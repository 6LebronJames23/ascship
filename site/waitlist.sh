#!/bin/sh
# Print the waitlist as CSV (email,source,signed_up). Needs `gcloud auth login` as the project owner.
TOK=$(gcloud auth print-access-token)
curl -s -H "Authorization: Bearer $TOK" -H "X-Goog-User-Project: ascship-waitlist" \
  "https://firestore.googleapis.com/v1/projects/ascship-waitlist/databases/(default)/documents/waitlist?pageSize=1000" |
python3 -c '
import json, sys
docs = json.load(sys.stdin).get("documents", [])
print("email,source,signed_up")
for d in sorted(docs, key=lambda d: d["createTime"]):
    f = d["fields"]
    print(f["email"]["stringValue"], f.get("source", {}).get("stringValue", ""), d["createTime"][:19], sep=",")
print(f"# {len(docs)} signups", file=sys.stderr)
'

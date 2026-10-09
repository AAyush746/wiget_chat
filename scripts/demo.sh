#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOT="$(dirname -- "$SCRIPT_DIR")"

for bin in curl jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "error: '$bin' is required" >&2; exit 1; }
done

if [[ ! -f "$ROOT/.env" ]]; then
  echo "error: $ROOT/.env not found" >&2
  exit 1
fi

env_get() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ROOT/.env" || true)"
  [[ -z "$line" ]] && return 1
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

API_PORT="$(env_get API_PORT || printf '%s' 4000)"
API="http://localhost:${API_PORT}"
ADMIN_EMAIL="$(env_get ADMIN_EMAIL || printf '%s' admin@chatflow.local)"
ADMIN_PASSWORD="$(env_get ADMIN_PASSWORD || true)"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "error: ADMIN_PASSWORD is not set in $ROOT/.env" >&2
  exit 1
fi

if ! curl -sf "$API/api/health" >/dev/null; then
  echo "error: API not reachable at $API" >&2
  echo "Start it first with: npm run dev" >&2
  exit 1
fi

RUN="$(date +%s)"
TAG="demo-$RUN"

echo "== 1/10 Login as admin ($ADMIN_EMAIL) =="
TOKEN="$(curl -sf -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" \
  | jq -er '.accessToken')"
echo "  ok: got accessToken"

echo "== 2/10 Create website (admin) =="
WEBSITE="$(curl -sf -X POST "$API/api/websites" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg n "Demo Store ($TAG)" --arg d "demo-$RUN.example.com" '{name:$n,domain:$d}')")"
WEBSITE_ID="$(jq -er '.id' <<<"$WEBSITE")"
PUBLIC_KEY="$(jq -er '.publicKey' <<<"$WEBSITE")"
echo "  ok: websiteId=$WEBSITE_ID publicKey=$PUBLIC_KEY"

echo "== 3/10 Create agent user (admin): alice-$RUN@chatflow.local =="
AGENT_EMAIL="alice-${RUN}@chatflow.local"
AGENT_PASSWORD="Agent12345"
AGENT="$(curl -sf -X POST "$API/api/users" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg e "$AGENT_EMAIL" --arg p "$AGENT_PASSWORD" --arg n "Alice ($TAG)" '{email:$e,password:$p,name:$n}')")"
AGENT_ID="$(jq -er '.id' <<<"$AGENT")"
echo "  ok: agentId=$AGENT_ID"

echo "== 4/10 Grant agent membership on the website (admin) =="
curl -sf -X POST "$API/api/websites/$WEBSITE_ID/memberships" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$AGENT_ID" '{userId:$u}')" >/dev/null
echo "  ok: membership created"

echo "== 5/10 Agent login + authorized-website list =="
AGENT_TOKEN="$(curl -sf -X POST "$API/api/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg e "$AGENT_EMAIL" --arg p "$AGENT_PASSWORD" '{email:$e,password:$p}')" \
  | jq -er '.accessToken')"
MY_COUNT="$(curl -sf "$API/api/me/websites" -H "Authorization: Bearer $AGENT_TOKEN" | jq 'length')"
echo "  ok: agent sees $MY_COUNT website(s)"

echo "== 6/10 Visitor initiates (widget API, no auth) =="
VISITOR="$(curl -sf -X POST "$API/api/public/websites/$PUBLIC_KEY/visitor" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg n "Ada ($TAG)" --arg e "ada-${RUN}@example.com" '{name:$n,email:$e}')")"
VISITOR_KEY="$(jq -er '.visitorKey' <<<"$VISITOR")"
echo "  ok: visitorKey=$VISITOR_KEY"

echo "== 7/10 Visitor opens a conversation + first message =="
CONV="$(curl -sf -X POST "$API/api/public/websites/$PUBLIC_KEY/conversations" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg v "$VISITOR_KEY" --arg s "Help with order #$RUN" '{visitorKey:$v,subject:$s}')")"
CONVERSATION_ID="$(jq -er '.id' <<<"$CONV")"
curl -sf -X POST "$API/api/public/websites/$PUBLIC_KEY/visitor/$VISITOR_KEY/conversations/$CONVERSATION_ID/messages" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n '{content:"Hi, my order has not shipped yet."}')" >/dev/null
echo "  ok: conversationId=$CONVERSATION_ID"

echo "== 8/10 Staff inbox preview (OPEN, awaiting staff) =="
curl -sf "$API/api/websites/$WEBSITE_ID/conversations?status=OPEN" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[] | "  open: \(.id)  preview: \(.lastMessage.content)"'

echo "== 9/10 Staff reply + thread =="
curl -sf -X POST "$API/api/websites/$WEBSITE_ID/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n '{content:"Thanks for your patience - it ships tomorrow."}')" >/dev/null
curl -sf "$API/api/websites/$WEBSITE_ID/conversations/$CONVERSATION_ID/messages" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data[] | "  \(.senderType)\t\(.content)"'

echo "== 10/10 Close conversation + verify read-only =="
curl -sf -X POST "$API/api/websites/$WEBSITE_ID/conversations/$CONVERSATION_ID/close" \
  -H "Authorization: Bearer $TOKEN" >/dev/null
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "$API/api/websites/$WEBSITE_ID/conversations/$CONVERSATION_ID/messages" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n '{content:"late reply"}')")"
VISITOR_CLOSED_AT="$(curl -sf "$API/api/public/websites/$PUBLIC_KEY/visitor/$VISITOR_KEY/conversations/$CONVERSATION_ID" \
  | jq -er '.closedAt')"
if [[ "$STATUS" != "409" || "$VISITOR_CLOSED_AT" == "null" ]]; then
  echo "error: closed-state check failed (status=$STATUS closedAt=$VISITOR_CLOSED_AT)" >&2
  exit 1
fi
echo "  ok: staff send after close -> HTTP $STATUS"
echo "  ok: visitor sees closedAt=$VISITOR_CLOSED_AT"

echo
echo "======================================== summary ========================================"
echo "  Run:                  $TAG"
echo "  Website id:           $WEBSITE_ID"
echo "  Website publicKey:    $PUBLIC_KEY"
echo "  Agent email:          $AGENT_EMAIL"
echo "  Agent password:       $AGENT_PASSWORD"
echo "  Conversation id:      $CONVERSATION_ID"
echo "  Dashboard:            $(curl -sf "$API/api/health" >/dev/null && echo 'http://localhost:5173')"
echo "=========================================================================================="
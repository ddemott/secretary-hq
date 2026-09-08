#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# seed-aiassistant-knowledge.sh — load __PERSONA_NAME__'s business knowledge base into tenant_docs
# (renamed from beth for generic aiassistant filename)
# ============================================================================
# Posts Q&A pairs to POST /knowledge/add. The backend generates pgvector
# embeddings server-side (uses its own OPENAI_API_KEY), so no local key is
# needed. Logs in as the Thinking Hammer owner so entries land on the right
# tenant. Re-running ADDS duplicate rows — only run once, or clear tenant_docs
# for the tenant first.
#
# Usage:
#   BACKEND_URL=https://secretary-hq-production.up.railway.app ./scripts/seed-aiassistant-knowledge.sh
# ============================================================================

BACKEND_URL="${BACKEND_URL:-https://secretary-hq-production.up.railway.app}"
OWNER_EMAIL="${OWNER_EMAIL:-daledemott@gmail.com}"
OWNER_PASS="${OWNER_PASS:-p@ssw0rd}"

echo "[chris-kb] Logging in as $OWNER_EMAIL ..."
TOKEN=$(curl -s -X POST "$BACKEND_URL/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASS\"}" \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "[chris-kb] ERROR: login failed — no token returned." >&2
  exit 1
fi
echo "[chris-kb] Authenticated."

add_qa() {
  local q="$1" a="$2"
  local payload
  payload=$(printf '{"question":"%s","answer":"%s","source":"aiassistant-knowledge-base"}' "$q" "$a")
  local resp
  resp=$(curl -s -X POST "$BACKEND_URL/knowledge/add" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$payload")
  if echo "$resp" | grep -q '"success":true'; then
    echo "[chris-kb]  + $q"
  else
    echo "[chris-kb]  ! FAILED: $q -> $resp" >&2
  fi
}

# --- About the business -----------------------------------------------------
add_qa "What is Thinking Hammer?" "Thinking Hammer LLC is Dale DeMott's software company. Dale builds custom software including web applications, AI integrations, SaaS platforms, and DevOps systems, drawing on 20 years in the IT industry. The tagline is Software That Thinks. You can learn more at thinkinghammer.com."
add_qa "Who is Dale?" "Dale DeMott is the founder of Thinking Hammer LLC. He has 20 years of experience in the IT industry building software and handling a wide range of development and DevOps work."
add_qa "How much experience does Dale have?" "Dale has 20 years of experience in the IT industry, building software and doing all kinds of development and operations work."
add_qa "What kind of work does Dale do?" "All of it. Full-stack web applications, AI integrations, SaaS platforms, and DevOps. If you have a software project in mind, the best next step is to schedule a meeting so Dale can hear the details."
add_qa "What has Dale built?" "Dale built SecretaryHQ from scratch, the AI receptionist service you are speaking with right now. He has other projects in the works too."
add_qa "What are the other projects Dale is working on?" "I am not at liberty to say. But you are welcome to check out thinkinghammer.com for more."
add_qa "Where is the website?" "thinkinghammer.com is where you will find more about Dale's work and services."

# --- Rates & pricing --------------------------------------------------------
add_qa "What are Dale's rates?" "The rate varies based on the job and the skills required. The best way to get an accurate number is to schedule a call so Dale can understand the scope of what you need."
add_qa "How much does it cost to hire Dale?" "It depends on the project. Rates vary with the job and the skills involved. I would recommend booking a meeting so Dale can give you a real answer based on your specifics."
add_qa "How much does SecretaryHQ cost?" "Pricing for SecretaryHQ is on the website at thinkinghammer.com. I would be happy to book a demo so Dale can walk you through what it does for your business."

# --- Work style & location --------------------------------------------------
add_qa "Is Dale remote or on-site?" "Dale works remotely, and will consider a hybrid arrangement of one or two days a week under certain circumstances."
add_qa "What are the circumstances for hybrid work?" "That is something best discussed directly. I would recommend scheduling a meeting with Dale to go over the details."
add_qa "Where is Dale located?" "Dale works remotely. For the right engagement he will consider hybrid, one or two days a week."

# --- SecretaryHQ ------------------------------------------------------------
add_qa "What is SecretaryHQ?" "SecretaryHQ is an AI receptionist service for businesses. It answers calls, schedules appointments, takes messages, and answers questions about your business around the clock. You are actually talking to it right now."
add_qa "Can I buy SecretaryHQ or the software?" "SecretaryHQ is offered as a service rather than sold as a product, but I would be glad to set up a demo so Dale can show you exactly what it can do for your business. Pricing details are at thinkinghammer.com."
add_qa "Can you build a SecretaryHQ for my company?" "SecretaryHQ is available as a service you can sign up for rather than something built from scratch for each company, which is what keeps it affordable and reliable. I would love to book you a demo so Dale can show you how it would work for your business."
add_qa "What can the AI assistant do?" "Quite a lot. I can answer your calls any time of day, schedule and book appointments, take detailed messages, answer common questions about your business, route callers to the right person, and follow up. All in a natural conversation, just like this one. Would you like to book a demo to see it for your own business?"

# --- Scheduling -------------------------------------------------------------
add_qa "When is Dale available to meet?" "Dale takes meetings Monday through Friday, with meetings wrapping up by 5 o'clock. I can find a time that works and book it for you right now."
add_qa "How do I schedule a call with Dale?" "I can do that for you right now. Just let me know roughly when works, and I will find an open time and book it."

echo "[chris-kb] Done."

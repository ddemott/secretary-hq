---
name: no-paid-api-keys
description: Dale pays only for subscriptions (Claude Max, SuperGrok) — never wire in paid per-token API keys
metadata:
  type: feedback
  tier: long
  created: 2026-09-23
  expires: never
---

Do not build or recommend anything that needs a paid, per-token API key (Anthropic, xAI, OpenAI...). Use subscription-backed paths: Claude Code on the Claude subscription, Hermes on Grok via OAuth, local models for background services.
**Why:** Dale will not pay per-token on top of his subscriptions.
**How to apply:** if a design needs an API key, say so and offer a subscription or local alternative first.

# Hydro AI Assistant

This package provides a minimal domain-scoped AI tutoring API for Hydro.

## Routes

- `GET /ai-assistant/status`
- `POST /ai-assistant/ask`
- `POST /ai-assistant/context/:contextType/:contextId`

The plugin stores tutoring turns in `ai_tutoring_sessions` and daily quota reset baselines in `ai_quota_resets`, matching the AI-EDU quota model at the field level.

## Provider Config

Configure providers in plugin config as a JSON array:

```json
[
  {
    "name": "anthropic-main",
    "type": "anthropic",
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "model": "claude-3-5-sonnet-latest",
    "maxTokens": 2000
  },
  {
    "name": "openai-responses",
    "type": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4.1-mini",
    "maxTokens": 2000
  }
]
```

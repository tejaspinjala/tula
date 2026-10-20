# Provider auth is per-provider data; subscriptions are metered in tokens

Each provider entry in a guild's routing data declares `auth: subscription | api_key`, so the Guild Master chooses Claude Max or API keys per provider. Hosted (v2) deployments reject `subscription` at config validation, because Anthropic's terms forbid products routing customer traffic through Free/Pro/Max credentials. On `subscription` the model gateway cannot inject a key or price calls, so it meters and caps tokens from the runtime's usage output instead of dollars; `api_key` providers are metered in both.

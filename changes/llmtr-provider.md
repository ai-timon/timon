---
type: added
---
**LLMTR** is a built-in provider. Save an inject secret named `LLMTR_API_KEY` (grant it to `global`, or to the `llmtr` backend) and allow the host `llmtr.com` in `pluginPolicy.http.byPlugin` for `provider-llmtr` (or in `pluginPolicy.http.allow`). Until that host is allowed, a turn fails and no request is sent. Missions then call Chat Completions at `https://llmtr.com/v1`; the model id is sent as written. The public model list does not check the key.

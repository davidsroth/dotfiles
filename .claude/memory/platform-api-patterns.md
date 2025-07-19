---
created: 2025-07-18
updated: 2025-07-18
tags: [api, platform, distillery, patterns]
---

# Platform API Patterns

Common patterns for working with Distillery platform APIs.

## API Response Structure

Most list endpoints return paginated responses:
```json
{
  "items": [...],
  "nextPageToken": "optional-token"
}
```

Handle both formats when fetching:
```python
if isinstance(data, dict) and "items" in data:
    items = data["items"]
elif isinstance(data, list):
    items = data
```

## System Version Management

### Version Aliases
Systems use aliases to track deployment states:
- `main`: Current main branch version
- `prod`: Production deployment
- `stage`: Staging deployment
- Custom aliases for specific environments

### Finding Latest Version
Priority order for determining latest:
1. Check `aliases["main"]`
2. Check branch endpoint for main branch
3. Use `aliases["prod"]` as fallback
4. Sort versions by version number

### Model Override Discovery
Model overrides exist at workflow level:
```python
# Fetch system details
system = GET /distillery/systems/{systemId}

# Check each workflow
for workflow in system.get("workflows", []):
    override = workflow.get("model_override") or workflow.get("modelOverride")
```

## Authentication Token Reuse
```python
def get_auth_token():
    # Check environment first
    token = os.getenv("TOWER_TOKEN") or os.getenv("DISTILLERY_TOKEN")
    
    # Fall back to saved tokens
    if not token and os.path.exists("tower_tokens.json"):
        with open("tower_tokens.json", "r") as f:
            tokens = json.load(f)
            token = tokens.get("access_token")
    
    return token
```
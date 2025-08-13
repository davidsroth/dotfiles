# Claude Project Tools Pattern

## Structure

Place Claude-specific helper scripts in project `.claude/` directories:

```text
project/.claude/
├── scripts/     # Helper scripts for Claude
└── docs/        # Claude-specific documentation
```

## Security

Never save tokens/credentials to disk. Use stdout → parse → pass via args.

## Benefits

- Keeps Claude tools with relevant code
- Discoverable when working in project
- Follows `.claude` convention
- Separates from application code

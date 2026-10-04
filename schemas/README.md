# Prelude JSON Schemas

One JSON Schema (draft-07) per file in the Prelude format. They ship in the npm package and are what `prelude validate` checks against. The prose specification is [spec.md](../spec.md).

| Schema | Validates | Written by |
|---|---|---|
| [project.schema.json](./project.schema.json) | `.context/project.json` | `init`, `update` |
| [stack.schema.json](./stack.schema.json) | `.context/stack.json` | `init`, `update` |
| [architecture.schema.json](./architecture.schema.json) | `.context/architecture.json` | `init`, `update` |
| [constraints.schema.json](./constraints.schema.json) | `.context/constraints.json` | `init`, `update` |
| [decisions.schema.json](./decisions.schema.json) | `.context/decisions.json` | `decision`, `prelude_record_decision` |
| [map.schema.json](./map.schema.json) | `.context/map.json` | `init`, `update`, `annotate` |
| [session.schema.json](./session.schema.json) | `.context/*.session.json` (local, gitignored) | `watch` |
| [export.schema.json](./export.schema.json) | `prelude export --format json` output | `export` |
| [workspace.schema.json](./workspace.schema.json) | `~/.prelude/workspace.json` | `workspace add`, `workspace remove` |

## Conventions

- Every schema sets `"additionalProperties": true`, so custom fields are valid and older validators accept files written by newer versions.
- Each `$id` lives under `https://adjective.us/prelude/schemas/v1/`. That is the format's namespace; validation uses the copies in this directory and never fetches over the network.
- Each schema mirrors a Zod schema in [`src/schema/`](../src/schema). A change to one must be made in the other.

## Validating

```bash
prelude validate          # every .context/ file, exit 1 on failure
```

To validate from another tool, point any draft-07 validator at the files in this directory, or at `node_modules/prelude-context/schemas/` after installing the package.

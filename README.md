# poc-all

Multi-project repository containing various proof-of-concept (POC) work for the
Product Engineering team.

## Purpose

This repository is a shared workspace for exploring ideas, prototypes, and
experiments that don't yet belong in a dedicated production repository. Each
proof of concept lives in its own directory under `projects/`, so unrelated
POCs can be developed, iterated on, and eventually archived or promoted
independently.

## Structure

```
poc-all/
├── README.md
└── projects/
    └── <project-name>/   # one directory per POC
```

## Adding a new POC

1. Create a new directory under `projects/` named after your proof of concept
   (e.g. `projects/my-poc-name/`).
2. Include a short `README.md` inside the project directory describing its
   purpose, how to run it, and any relevant context or status (active,
   archived, etc.).
3. Keep each POC self-contained (its own dependencies, build/test tooling,
   etc.) so projects don't interfere with one another.
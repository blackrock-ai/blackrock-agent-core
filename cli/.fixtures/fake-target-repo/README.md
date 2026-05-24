# fake-target-repo — fixture for cli/install.sh --dry-run

This directory is a fixture that the Agent Core installer's dry-run tests
target instead of a real client project. It mimics the minimal shape the
installer expects: a `.git/` directory, a `supabase/` directory with a
`config.toml`, and a web source directory.

The inner `.git/` is gitignored from the outer repo (git refuses nested
embedded repos). Recreate it locally before running the dry-run test:

```bash
cd cli/.fixtures/fake-target-repo && git init -q && cd ../../..
./cli/install.sh --dry-run --assume-exposed --config cli/install.config
```

The dry-run mutates nothing in this fixture or anywhere else. Live remote
checks (Supabase CLI, GitHub Packages auth) are stubbed out in dry-run mode.

---
name: caveman-comments
description: compress prose in code while preserving technical substance. Use when user asks for terse/caveman comments, docstrings/docs, or compression of JSDoc, NumPy docstrings, Rustdoc, #, or // comments.
---

Caveman comments: substance stay, fluff die. Why > what.

## Mode

Once triggered, apply to every new or touched comment/docstring this session.

## Process

1. Bound scope: comments/docstrings only. Never change code, signatures, imports, or behavior.
2. Delete restaters: if code already says it, remove the comment instead of compressing it.
3. Compress survivors: fragments OK; articles gone; filler gone; hedging gone; short words; arrows for causality (`X -> Y`).
4. Preserve contracts: technical terms, error strings, types, units, side effects, preconditions, invariants.
5. Use safety exception only when terse risks harm: `unsafe`, security warnings, irreversible ops, tricky preconditions. Full sentences allowed there; return to caveman after.

Done when every targeted comment/docstring is deleted as restater, left untouched by boundary, or compressed with all contracts preserved.

## Compression Rules

Drop:

- Articles: `a`, `an`, `the`
- Filler: `just`, `really`, `basically`, `simply`
- Pleasantries, throat-clearing, narrative
- Prose that repeats nearby code

Prefer:

- Imperative mood
- One word when enough
- `X -> Y` for causality
- Exact domain words over generic synonyms

Bad: `// We need to do this because the API sometimes returns null on rate-limit`
Good: `// API null on rate-limit -> retry once.`

Bad: `// Increment the counter by one`
Good: delete.

## Formats

### Python — NumPy docstrings

Keep section headers (`Parameters`, `Returns`, `Raises`, `Notes`). Compress prose inside.

```python
def fetch_user(user_id: int) -> User:
    """Fetch user. Cache stale ≤60s.

    Parameters
    ----------
    user_id : int
        Unique id. Negative -> raises.

    Returns
    -------
    User
        Hydrated. Never None.

    Raises
    ------
    ValueError
        user_id < 0.
    """
```

- Tests: one-line docstring.
- `__init__.py`: one-line module summary.

### TypeScript / JavaScript — JSDoc

Keep tags (`@module`, `@param`, `@returns`, `@throws`). Bodies terse.

```ts
/**
 * @module userService
 * Fetch users. Cache stale ≤60s.
 */

/**
 * Fetch user by id.
 * @param id - User id. Negative -> throws.
 * @returns Hydrated user. Never null.
 * @throws {RangeError} id < 0.
 */
```

### Rust — Rustdoc

Keep `///` and `//!`. Keep sections (`# Errors`, `# Panics`, `# Safety`, `# Examples`). Compress prose.

```rust
/// Fetch user. Cache stale ≤60s.
///
/// # Errors
/// `Err` if id < 0 or DB unreachable.
fn fetch_user(id: i64) -> Result<User, FetchErr> { ... }
```

## Safety Exception

```rust
/// # Safety
///
/// Caller must ensure `ptr` is non-null, aligned to 8 bytes, and that no
/// other reference to the same memory exists for the duration of this call.
/// Violating either constraint is undefined behavior.
```

## Boundaries

- Rewrite prose inside comments/docstrings only.
- Keep project-required prefixes (`# ##!:`, `// [!]:`, etc.); compress text after prefix only.
- Keep licenses, generated-file banners, and external spec text exact unless user explicitly asks.

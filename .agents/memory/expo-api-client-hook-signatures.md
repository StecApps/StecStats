---
name: Expo API client hook signatures
description: Orval-generated hook call patterns for @workspace/api-client-react in Expo/React Native
---

## Rule
All Orval-generated hooks follow these patterns. Getting them wrong causes silent no-ops or TS errors.

**Why:** Orval wraps TanStack Query; query options are nested under a `query` key, and mutation variables always use a `data` wrapper.

## Query hooks with conditional fetching
```ts
// WRONG — options spread at top level
useListTeamGames(teamId, { enabled: !!team });

// CORRECT — nested under `query`
useListTeamGames(teamId, { query: { enabled: !!team } });
```

## Mutation hooks
```ts
// WRONG — bare payload
createTeamMutation.mutateAsync({ name: 'Hawks', sport: 'basketball' });

// CORRECT — wrapped in `data`
createTeamMutation.mutateAsync({ data: { name: 'Hawks', sport: 'basketball' } });

// Same pattern for createGame, updateGame, createPlayer, etc.
createGame.mutateAsync({ data: { teamId, opponent, date, result, teamScore, ... } });
```

## GenerateGameHighlight (special case)
```ts
// Variables are NOT wrapped in `data` — they are top-level
generateMutation.mutateAsync({ gameId: 42 });
```

**How to apply:** When in doubt, grep the generated signature in `lib/api-client-react/src/generated/api.ts` for the exact `mutationFn` parameter shape.

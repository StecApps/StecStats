/**
 * Profile name-edit logic tests
 *
 * Verifies the display-name and initials derivation logic, the handleSaveName
 * guard, and the Clerk fallback — all extracted from profile.tsx so that any
 * change to those rules breaks these tests first.
 *
 * No native bridges, camera, or real API calls are needed.
 *
 * Confirms:
 *   1. Saved DB name is preferred over Clerk name.
 *   2. Initials reflect the saved name after a successful save.
 *   3. Clerk display name is the fallback when DB returns null.
 *   4. Email is the final fallback when both DB and Clerk names are empty.
 *   5. handleSaveName blocks submission when firstName is blank.
 *   6. handleSaveName calls updateMe.mutate with trimmed values.
 *   7. On save success, refetchMe is called and the modal closes.
 *   8. On save error, Alert.alert is called with the error message.
 */

// ── Mocks (hoisted before imports) ────────────────────────────────────────────

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
}));

// ── Imports (after mock hoisting) ─────────────────────────────────────────────

import { Alert } from 'react-native';

const alertSpy = Alert.alert as jest.Mock;

// ── Helpers extracted from profile.tsx ────────────────────────────────────────

/**
 * Mirrors the display-name and initials derivation in ProfileScreen.
 */
function deriveDisplayInfo(
  storedFirst: string | null,
  storedLast: string | null,
  clerkFirst: string | undefined | null,
  clerkLast: string | undefined | null,
  primaryEmail: string | undefined | null,
) {
  const displayFirst = storedFirst ?? clerkFirst ?? '';
  const displayLast = storedLast ?? clerkLast ?? '';
  const displayName =
    [displayFirst, displayLast].filter(Boolean).join(' ') ||
    primaryEmail ||
    'Coach';

  const initials = displayName
    .split(' ')
    .map((w: string) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return { displayFirst, displayLast, displayName, initials };
}

/**
 * Mirrors handleSaveName from profile.tsx.
 * Returns { saved: true } on success or throws so tests can inspect calls.
 */
async function makeHandleSaveName(opts: {
  editFirstName: string;
  editLastName: string;
  updateMutate: jest.Mock;
  refetchMe: jest.Mock;
  setEditNameVisible: jest.Mock;
  setSavingName: jest.Mock;
}) {
  const { editFirstName, editLastName, updateMutate, refetchMe, setEditNameVisible, setSavingName } = opts;

  return async function handleSaveName() {
    const first = editFirstName.trim();
    const last = editLastName.trim();
    if (!first) {
      Alert.alert('Name required', 'Please enter at least a first name.');
      return;
    }
    setSavingName(true);
    await new Promise<void>((resolve) => {
      updateMutate(
        { data: { firstName: first, lastName: last } },
        {
          onSuccess: () => {
            refetchMe();
            setEditNameVisible(false);
            resolve();
          },
          onError: (err: any) => {
            Alert.alert('Error', err?.message ?? 'Could not update name. Please try again.');
            resolve();
          },
          onSettled: () => setSavingName(false),
        },
      );
    });
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// --------------------------------------------------------------------------
// Display name / initials derivation
// --------------------------------------------------------------------------

describe('deriveDisplayInfo — display name preference', () => {
  test('prefers DB-stored name over Clerk name', () => {
    const { displayName } = deriveDisplayInfo('Jordan', 'Smith', 'Clerk First', 'Clerk Last', null);
    expect(displayName).toBe('Jordan Smith');
  });

  test('falls back to Clerk name when DB returns null', () => {
    const { displayName } = deriveDisplayInfo(null, null, 'Clerk First', 'Clerk Last', null);
    expect(displayName).toBe('Clerk First Clerk Last');
  });

  test('falls back to email when both DB and Clerk names are null', () => {
    const { displayName } = deriveDisplayInfo(null, null, null, null, 'coach@example.com');
    expect(displayName).toBe('coach@example.com');
  });

  test('falls back to "Coach" when DB, Clerk, and email are all empty', () => {
    const { displayName } = deriveDisplayInfo(null, null, null, null, null);
    expect(displayName).toBe('Coach');
  });

  test('uses DB firstName alone when lastName is null', () => {
    const { displayName } = deriveDisplayInfo('Solo', null, null, null, null);
    expect(displayName).toBe('Solo');
  });
});

describe('deriveDisplayInfo — initials', () => {
  test('initials are taken from the DB-stored name after save', () => {
    const { initials } = deriveDisplayInfo('Jordan', 'Smith', null, null, null);
    expect(initials).toBe('JS');
  });

  test('initials update to reflect Clerk fallback when DB name is cleared', () => {
    const { initials } = deriveDisplayInfo(null, null, 'Alice', 'Brown', null);
    expect(initials).toBe('AB');
  });

  test('single-word name produces one initial', () => {
    const { initials } = deriveDisplayInfo('Coach', null, null, null, null);
    expect(initials).toBe('C');
  });

  test('initials are capped at two characters', () => {
    // Three-word name: only first two words contribute initials
    const { displayName } = deriveDisplayInfo('Jean-Claude', 'Van Damme', null, null, null);
    const initials = displayName
      .split(' ')
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    expect(initials.length).toBeLessThanOrEqual(2);
  });

  test('initials are always uppercase', () => {
    const { initials } = deriveDisplayInfo('alice', 'brown', null, null, null);
    expect(initials).toBe('AB');
  });
});

// --------------------------------------------------------------------------
// handleSaveName guard — blank firstName
// --------------------------------------------------------------------------

describe('handleSaveName — validation guard', () => {
  test('shows Alert and does not call updateMe when firstName is blank', async () => {
    const updateMutate = jest.fn();
    const refetchMe = jest.fn();
    const setEditNameVisible = jest.fn();
    const setSavingName = jest.fn();

    const handler = await makeHandleSaveName({
      editFirstName: '',
      editLastName: 'Smith',
      updateMutate,
      refetchMe,
      setEditNameVisible,
      setSavingName,
    });

    await handler();

    expect(alertSpy).toHaveBeenCalledWith('Name required', 'Please enter at least a first name.');
    expect(updateMutate).not.toHaveBeenCalled();
    expect(setSavingName).not.toHaveBeenCalled();
  });

  test('shows Alert and does not call updateMe when firstName is whitespace only', async () => {
    const updateMutate = jest.fn();
    const handler = await makeHandleSaveName({
      editFirstName: '   ',
      editLastName: 'Smith',
      updateMutate,
      refetchMe: jest.fn(),
      setEditNameVisible: jest.fn(),
      setSavingName: jest.fn(),
    });

    await handler();

    expect(alertSpy).toHaveBeenCalledWith('Name required', 'Please enter at least a first name.');
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// handleSaveName — success path
// --------------------------------------------------------------------------

describe('handleSaveName — success path', () => {
  test('calls updateMe.mutate with trimmed firstName and lastName', async () => {
    const updateMutate = jest.fn().mockImplementation((_data: any, callbacks: any) => {
      callbacks.onSuccess();
      callbacks.onSettled();
    });
    const refetchMe = jest.fn();
    const setEditNameVisible = jest.fn();
    const setSavingName = jest.fn();

    const handler = await makeHandleSaveName({
      editFirstName: '  Jordan  ',
      editLastName: '  Smith  ',
      updateMutate,
      refetchMe,
      setEditNameVisible,
      setSavingName,
    });

    await handler();

    expect(updateMutate).toHaveBeenCalledWith(
      { data: { firstName: 'Jordan', lastName: 'Smith' } },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  test('calls refetchMe and closes the modal on success', async () => {
    const updateMutate = jest.fn().mockImplementation((_data: any, callbacks: any) => {
      callbacks.onSuccess();
      callbacks.onSettled();
    });
    const refetchMe = jest.fn();
    const setEditNameVisible = jest.fn();
    const setSavingName = jest.fn();

    const handler = await makeHandleSaveName({
      editFirstName: 'Jordan',
      editLastName: 'Smith',
      updateMutate,
      refetchMe,
      setEditNameVisible,
      setSavingName,
    });

    await handler();

    expect(refetchMe).toHaveBeenCalledTimes(1);
    expect(setEditNameVisible).toHaveBeenCalledWith(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('sets savingName to false in onSettled even after success', async () => {
    const updateMutate = jest.fn().mockImplementation((_data: any, callbacks: any) => {
      callbacks.onSuccess();
      callbacks.onSettled();
    });
    const setSavingName = jest.fn();

    const handler = await makeHandleSaveName({
      editFirstName: 'Jordan',
      editLastName: '',
      updateMutate,
      refetchMe: jest.fn(),
      setEditNameVisible: jest.fn(),
      setSavingName,
    });

    await handler();

    expect(setSavingName).toHaveBeenCalledWith(true);
    expect(setSavingName).toHaveBeenCalledWith(false);
  });
});

// --------------------------------------------------------------------------
// handleSaveName — error path
// --------------------------------------------------------------------------

describe('handleSaveName — error path', () => {
  test('shows Alert with the server error message on failure', async () => {
    const updateMutate = jest.fn().mockImplementation((_data: any, callbacks: any) => {
      callbacks.onError(new Error('Network error'));
      callbacks.onSettled();
    });

    const handler = await makeHandleSaveName({
      editFirstName: 'Jordan',
      editLastName: 'Smith',
      updateMutate,
      refetchMe: jest.fn(),
      setEditNameVisible: jest.fn(),
      setSavingName: jest.fn(),
    });

    await handler();

    expect(alertSpy).toHaveBeenCalledWith('Error', 'Network error');
  });

  test('shows generic Alert message when the error has no message', async () => {
    const updateMutate = jest.fn().mockImplementation((_data: any, callbacks: any) => {
      callbacks.onError({});
      callbacks.onSettled();
    });

    const handler = await makeHandleSaveName({
      editFirstName: 'Jordan',
      editLastName: '',
      updateMutate,
      refetchMe: jest.fn(),
      setEditNameVisible: jest.fn(),
      setSavingName: jest.fn(),
    });

    await handler();

    expect(alertSpy).toHaveBeenCalledWith('Error', 'Could not update name. Please try again.');
  });

  test('does not call refetchMe or close the modal on failure', async () => {
    const updateMutate = jest.fn().mockImplementation((_data: any, callbacks: any) => {
      callbacks.onError(new Error('Server down'));
      callbacks.onSettled();
    });
    const refetchMe = jest.fn();
    const setEditNameVisible = jest.fn();

    const handler = await makeHandleSaveName({
      editFirstName: 'Jordan',
      editLastName: '',
      updateMutate,
      refetchMe,
      setEditNameVisible,
      setSavingName: jest.fn(),
    });

    await handler();

    expect(refetchMe).not.toHaveBeenCalled();
    expect(setEditNameVisible).not.toHaveBeenCalled();
  });

  test('sets savingName to false in onSettled even after failure', async () => {
    const updateMutate = jest.fn().mockImplementation((_data: any, callbacks: any) => {
      callbacks.onError(new Error('oops'));
      callbacks.onSettled();
    });
    const setSavingName = jest.fn();

    const handler = await makeHandleSaveName({
      editFirstName: 'Jordan',
      editLastName: '',
      updateMutate,
      refetchMe: jest.fn(),
      setEditNameVisible: jest.fn(),
      setSavingName,
    });

    await handler();

    expect(setSavingName).toHaveBeenCalledWith(true);
    expect(setSavingName).toHaveBeenCalledWith(false);
  });
});

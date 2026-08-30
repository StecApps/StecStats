let mockRemovedKeys: string[] = [];

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    removeItem: jest.fn(async (key: string) => {
      mockRemovedKeys.push(key);
    }),
  },
}));

import {
  clearDeletedAccountDataThenSignOut,
  clearDeletedAccountLocalData,
} from '@/lib/accountDeletionCleanup';

describe('clearDeletedAccountLocalData', () => {
  beforeEach(() => {
    mockRemovedKeys = [];
  });

  it('removes recoverable stats, uploads, and account-scoped photo queues', async () => {
    await clearDeletedAccountLocalData('user_deleted_coach');

    expect(mockRemovedKeys).toEqual(expect.arrayContaining([
      'stec:scorekeeper-draft',
      'stec:offline-game-queue',
      'stec:pending-mobile-upload',
      'pending_photo_uploads_v1_user_deleted_coach',
    ]));
  });

  it('clears every local recovery key before signing out', async () => {
    const order: string[] = [];
    const signOut = jest.fn(async () => {
      order.push('sign-out');
    });
    const asyncStorage = require('@react-native-async-storage/async-storage').default;
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      order.push(key);
    });

    await clearDeletedAccountDataThenSignOut('user_deleted_coach', signOut);

    expect(order.slice(0, 4)).toEqual(expect.arrayContaining([
      'stec:scorekeeper-draft',
      'stec:offline-game-queue',
      'stec:pending-mobile-upload',
      'pending_photo_uploads_v1_user_deleted_coach',
    ]));
    expect(order[4]).toBe('sign-out');
  });

  it('does not sign out when local cleanup fails so cleanup remains retryable', async () => {
    const asyncStorage = require('@react-native-async-storage/async-storage').default;
    asyncStorage.removeItem.mockRejectedValueOnce(new Error('storage unavailable'));
    const signOut = jest.fn(async () => {});

    await expect(
      clearDeletedAccountDataThenSignOut('user_deleted_coach', signOut),
    ).rejects.toThrow('storage unavailable');
    expect(signOut).not.toHaveBeenCalled();
  });
});
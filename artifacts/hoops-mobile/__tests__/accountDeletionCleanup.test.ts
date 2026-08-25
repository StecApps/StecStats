let mockRemovedKeys: string[] = [];

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    removeItem: jest.fn(async (key: string) => {
      mockRemovedKeys.push(key);
    }),
  },
}));

import { clearDeletedAccountLocalData } from '@/lib/accountDeletionCleanup';

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
});
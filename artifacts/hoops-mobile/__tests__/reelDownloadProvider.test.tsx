import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => jest.fn()) },
}));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  FileSystemSessionType: { BACKGROUND: 0 },
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: false, uri: '', size: 0 })),
  deleteAsync: jest.fn(() => Promise.resolve()),
  makeDirectoryAsync: jest.fn(() => Promise.resolve()),
  createDownloadResumable: jest.fn(),
}));

import { ReelDownloadProvider, reelDownloadManager } from '@/lib/reelDownloadManager';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ReelDownloadProvider auth lifecycle', () => {
  afterEach(() => jest.restoreAllMocks());

  test('activates the signed-in account before initial discovery', async () => {
    const calls: string[] = [];
    jest.spyOn(reelDownloadManager, 'activate').mockImplementation(async (accountId) => {
      calls.push(`activate:${accountId}`);
    });
    jest.spyOn(reelDownloadManager, 'discover').mockImplementation(async (token) => {
      calls.push(`discover:${token}`);
    });
    const getToken = jest.fn(async () => {
      calls.push('token');
      return 'coach-token';
    });

    await act(async () => {
      TestRenderer.create(
        <ReelDownloadProvider accountId="coach-a" getToken={getToken}>
          {null}
        </ReelDownloadProvider>,
      );
      await flush();
    });

    expect(calls).toEqual(['activate:coach-a', 'token', 'discover:coach-token']);
  });

  test('does not discover for an account replaced while its token is pending', async () => {
    let releaseFirst!: (token: string | null) => void;
    const firstToken = new Promise<string | null>((resolve) => { releaseFirst = resolve; });
    const getTokenA = jest.fn(() => firstToken);
    const getTokenB = jest.fn(async () => 'token-b');
    jest.spyOn(reelDownloadManager, 'activate').mockResolvedValue();
    const discover = jest.spyOn(reelDownloadManager, 'discover').mockResolvedValue();
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <ReelDownloadProvider accountId="coach-a" getToken={getTokenA}>
          {null}
        </ReelDownloadProvider>,
      );
      await flush();
    });
    await act(async () => {
      renderer.update(
        <ReelDownloadProvider accountId="coach-b" getToken={getTokenB}>
          {null}
        </ReelDownloadProvider>,
      );
      await flush();
    });
    await act(async () => {
      releaseFirst('token-a');
      await flush();
    });

    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledWith('token-b');
  });
});
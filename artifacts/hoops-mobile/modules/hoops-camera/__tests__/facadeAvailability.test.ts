jest.mock('expo', () => ({
  requireOptionalNativeModule: () => null,
  requireNativeView: () => {
    throw new Error('native view should not be requested when unavailable');
  },
}));

describe('HoopsCamera facade feature detection', () => {
  it('is safe to import without the local native client', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const facade = require('../src') as typeof import('../src');

    expect(facade.isHoopsCameraAvailable).toBe(false);
    expect(facade.HoopsCameraView).toBeNull();
    expect(() => facade.startHoopsCameraRecordingAsync()).toThrow(
      'HoopsCamera is unavailable',
    );
  });
});
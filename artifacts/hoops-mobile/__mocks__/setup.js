// React Native reads __DEV__ at module load time; define it before any import.
global.__DEV__ = false;

// Required for react-test-renderer's act() to work in the Node test environment.
global.IS_REACT_ACT_ENVIRONMENT = true;

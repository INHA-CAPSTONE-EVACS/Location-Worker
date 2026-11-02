'use strict';

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/unit'],
      transform: {
        '^.+\\.ts$': ['ts-jest', {tsconfig: '<rootDir>/tsconfig.json'}],
      },
    },
  ],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageThreshold: {
    global: {statements: 85, branches: 85, functions: 85, lines: 85},
  },
};

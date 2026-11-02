'use strict';

const transform = {
  '^.+\\.ts$': ['ts-jest', {tsconfig: '<rootDir>/tsconfig.json'}],
};

/** @type {import('jest').Config} */
module.exports = {
  // 통합 시험은 공유 Redis를 쓰므로 직렬로 돈다
  maxWorkers: 1,
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/unit'],
      transform,
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      roots: ['<rootDir>/test/integration'],
      transform,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts'],
  coverageThreshold: {
    global: {statements: 85, branches: 85, functions: 85, lines: 85},
  },
};

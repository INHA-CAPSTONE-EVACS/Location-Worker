// 프로세스 시험용 진입점. 운영 진입점(src/main.ts)에 장애 주입 훅만 더한다.
import {runWorker} from '../../src/main';
import type {TestFaults} from './process-harness';

const faults = JSON.parse(process.env.LW_TEST_FAULTS ?? '{}') as TestFaults;

const crash = () => {
  process.kill(process.pid, 'SIGKILL');
  return new Promise<void>(() => {});
};

void runWorker({
  faults: {
    beforeProcess: async ({vehicleId}) => {
      if (vehicleId === faults.crashBeforeProcess) await crash();
      if (vehicleId === faults.hang) await new Promise<void>(() => {});
      if (faults.slow && vehicleId === faults.slow.vehicleId) {
        await new Promise(resolve => setTimeout(resolve, faults.slow!.ms));
      }
    },
    afterCommit: async ({vehicleId}) => {
      if (vehicleId === faults.crashAfterCommit) await crash();
    },
  },
});

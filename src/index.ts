import {
  loadSpikeConfig,
  printSummary,
  runActionsFile,
  runBlockerScenario,
  runMainScenario,
  runRealProductScenario,
  type SpikeOptions,
} from './cli/spike-runner.js';

function readArg(name: string): string | undefined {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const scenario = readArg('--scenario') ?? 'main';
  const actionsFile = readArg('--actions');
  const storageStatePath = readArg('--storage-state');
  const headed = process.argv.slice(2).includes('--headed');
  const approve = process.argv.slice(2).includes('--approve');

  const options: SpikeOptions = {
    scenario: actionsFile ? 'actions-file' : scenario,
    headed,
    approve,
    ...(actionsFile ? { actionsFile } : {}),
    ...(storageStatePath ? { storageStatePath } : {}),
  };

  const config = loadSpikeConfig(options);
  console.log('=== 浏览器自动化执行层 Spike ===');
  console.log(
    `scenario=${options.scenario} browser=${config.browserChannel} headless=${config.headless} approval=${approve ? 'auto' : 'require_approval'}`
  );
  console.log(`web=${config.webUrl}`);
  console.log('');

  let result;

  if (actionsFile) {
    result = await runActionsFile(config, { ...options, actionsFile });
  } else {
    switch (scenario) {
      case 'main':
        result = await runMainScenario(config, options);
        break;
      case 'blocker':
        result = await runBlockerScenario(config, options);
        break;
      case 'real-product':
        result = await runRealProductScenario(config, options);
        break;
      default:
        throw new Error(`未知 scenario「${scenario}」，可选 main / blocker / real-product`);
    }
  }

  printSummary(result);

  if (result.scenario === 'main' && !result.gateBlocked) {
    console.log('注意：本次 main 场景未触发 approval-gate（可能使用了 --approve 放行）。');
  }

  const antiAutomation = result.steps.some(
    (step) => step.error?.code === 'ANTI_AUTOMATION_DETECTED'
  );
  process.exitCode = result.status === 'passed' ? 0 : antiAutomation ? 2 : 1;
}

main().catch((error) => {
  console.error('');
  console.error(`[spike] 启动失败：${(error as Error).message}`);
  process.exitCode = 1;
});

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PersistentResolveBridge } from '../src/bridge.js';

test('the bundled Python bridge speaks persistent JSONL without Resolve', async () => {
	const script = fileURLToPath(new URL('../src/resolve_bridge.py', import.meta.url));
	const bridge = new PersistentResolveBridge('python3', script, 15_000);
	try {
		const first = await bridge.call('probe', {});
		const second = await bridge.call('probe', {});
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(JSON.stringify(first)).toContain('"connected":');
	} finally {
		await bridge.close();
	}
});

test('Resolve numeric setting normalization compares semantically', () => {
	const script = fileURLToPath(new URL('../src/resolve_bridge.py', import.meta.url));
	const source = [
		'import importlib.util, json, sys',
		'spec = importlib.util.spec_from_file_location("artists_resolve_bridge", sys.argv[1])',
		'module = importlib.util.module_from_spec(spec)',
		'spec.loader.exec_module(module)',
		'print(json.dumps([',
		'  module._setting_equal("25.0", "25"),',
		'  module._setting_equal("1", "1.0"),',
		'  module._setting_equal("DaVinci YRGB", "DaVinci YRGB"),',
		'  module._setting_equal("24", "25")',
		']), file=module.OUTPUT)',
	].join('\n');
	const result = spawnSync('python3', ['-c', source, script], { encoding: 'utf8' });
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout) as unknown).toEqual([true, true, true, false]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibOnvifSession } from '../src/onvif/adapter.js';
import type { Onvif } from '../src/onvif/types.js';

// Tapo C520WS отдаёт token пресета числом; контракт API требует строку,
// иначе проверка принадлежности token в ptzGotoPreset даёт 404 на существующий пресет.
test('preset tokens normalized to strings', async () => {
  const client = {
    ptz: {
      getPresets: async () => [
        { token: 1, name: 'Работник' },
        { token: 2 },
        { token: null, name: 'broken' },
      ],
    },
  } as unknown as Onvif;
  const session = new LibOnvifSession(client);
  const presets = await session.getPtzPresets('profile_1');
  assert.deepEqual(presets, [
    { token: '1', name: 'Работник' },
    { token: '2', name: '2' },
  ]);
});
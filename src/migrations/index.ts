import * as migration_20260707_153821_initial from './20260707_153821_initial';

export const migrations = [
  {
    up: migration_20260707_153821_initial.up,
    down: migration_20260707_153821_initial.down,
    name: '20260707_153821_initial'
  },
];

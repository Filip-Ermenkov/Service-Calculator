import * as migration_20260707_153821_initial from './20260707_153821_initial';
import * as migration_20260717_164130_phase2b_slug_service_snapshot from './20260717_164130_phase2b_slug_service_snapshot';
import * as migration_20260825_173608_service_editor_unit_default_on from './20260825_173608_service_editor_unit_default_on';

export const migrations = [
  {
    up: migration_20260707_153821_initial.up,
    down: migration_20260707_153821_initial.down,
    name: '20260707_153821_initial',
  },
  {
    up: migration_20260717_164130_phase2b_slug_service_snapshot.up,
    down: migration_20260717_164130_phase2b_slug_service_snapshot.down,
    name: '20260717_164130_phase2b_slug_service_snapshot',
  },
  {
    up: migration_20260825_173608_service_editor_unit_default_on.up,
    down: migration_20260825_173608_service_editor_unit_default_on.down,
    name: '20260825_173608_service_editor_unit_default_on'
  },
];
